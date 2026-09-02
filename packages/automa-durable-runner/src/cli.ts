/**
 * The command line: define a flow in a JSON file, run it, inspect it.
 *
 *   automa-runner run flow.json            start a run and follow it
 *   automa-runner status <runId>           where did it get to
 *   automa-runner resume <runId> <nodeId>  re-run from a step
 *   automa-runner dlq                      what needs a human
 *   automa-runner replay <dlqEntryId>      run a dead-lettered step again
 *   automa-runner health                   is partition maintenance alive
 *
 * Deliberately thin. Everything here is a few lines over the library API, so
 * the CLI cannot quietly become a second implementation of the engine with
 * different behaviour.
 */

import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createPool, withTransaction } from './db/client.ts'
import {
  createRun,
  getRun,
  listDlqEntries,
  listSteps,
} from './engine/repository.ts'
import { drainUntilQuiet } from './engine/drain.ts'
import { replayDlqEntry, resumeRun } from './engine/resume.ts'
import { partitionHealth } from './engine/janitor.ts'
import { defaultHandlers } from './engine/handlers.ts'
import type { FlowDefinition } from './types.ts'

const USAGE = `automa-runner — a durable step engine

  run <flow.json> [--tenant <uuid>] [--watch]
  status <runId> <runStartedAt>
  resume <runId> <runStartedAt> <nodeId>
  dlq [--tenant <uuid>]
  replay <dlqEntryId>
  health

A flow file looks like:

{
  "id": "8f...",              // optional, generated if absent
  "versionId": "1a...",       // optional
  "nodes": [
    { "id": "fetch", "kind": "http", "idempotent": true,
      "config": { "url": "https://example.com/" } },
    { "id": "done",  "kind": "noop", "idempotent": true }
  ]
}
`

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

/**
 * Read and check a flow file.
 *
 * Validated here rather than at insert time so a typo produces a sentence
 * about the file, not a constraint violation halfway through a transaction.
 */
async function loadFlow(path: string): Promise<FlowDefinition> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    fail(`could not read ${path}: ${(error as Error).message}`)
  }

  const candidate = parsed as Partial<FlowDefinition>
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0) {
    fail(`${path}: "nodes" must be a non-empty array`)
  }

  const seen = new Set<string>()
  for (const [index, node] of candidate.nodes.entries()) {
    if (typeof node.id !== 'string' || node.id.length === 0) {
      fail(`${path}: node ${index} has no "id"`)
    }
    if (seen.has(node.id)) fail(`${path}: duplicate node id ${JSON.stringify(node.id)}`)
    seen.add(node.id)
    if (typeof node.kind !== 'string') fail(`${path}: node ${node.id} has no "kind"`)
    if (typeof node.idempotent !== 'boolean') {
      // Not defaulted on purpose. Whether a step is safe to repeat decides
      // whether an ambiguous failure retries or stops and asks a human, and
      // guessing on the author's behalf is exactly the wrong call to make
      // silently.
      fail(
        `${path}: node ${node.id} must declare "idempotent": true or false — ` +
          `it decides whether an ambiguous failure is retried or paused for review`,
      )
    }
  }

  return {
    id: candidate.id ?? randomUUID(),
    versionId: candidate.versionId ?? randomUUID(),
    nodes: candidate.nodes as FlowDefinition['nodes'],
  }
}

const [, , command, ...args] = process.argv
const pool = createPool()

try {
  switch (command) {
    case 'run': {
      const path = args[0]
      if (path === undefined) fail(USAGE)
      const flow = await loadFlow(path)
      const tenantId = flag(args, 'tenant') ?? randomUUID()

      const { run } = await withTransaction(pool, (tx) =>
        createRun(tx, { tenantId, flow }),
      )
      console.log(`run     ${run.id}`)
      console.log(`started ${run.startedAt.toISOString()}`)
      console.log(`tenant  ${tenantId}`)

      if (args.includes('--watch')) {
        console.log('\nrunning...')
        await drainUntilQuiet(
          pool,
          { flow, handlers: defaultHandlers(), workerId: 'cli' },
          { tenantId },
        )
        await printStatus(run.id, run.startedAt)
      } else {
        console.log('\nqueued. Start a worker, or re-run with --watch.')
      }
      break
    }

    case 'status': {
      const [runId, startedAt] = args
      if (runId === undefined || startedAt === undefined) fail(USAGE)
      await printStatus(runId, new Date(startedAt))
      break
    }

    case 'resume': {
      const [runId, startedAt, nodeId] = args
      if (runId === undefined || startedAt === undefined || nodeId === undefined) fail(USAGE)
      const result = await withTransaction(pool, (tx) =>
        resumeRun(tx, { runId, runStartedAt: new Date(startedAt), fromNodeId: nodeId }),
      )
      console.log(`attempt group ${result.attemptGroup}`)
      console.log(`preserved     ${result.skipped.join(', ') || '(none)'}`)
      console.log(`will re-run   ${result.reset.join(', ')}`)
      break
    }

    case 'dlq': {
      const tenantId = flag(args, 'tenant')
      const entries = await listDlqEntries(pool, tenantId === undefined ? {} : { tenantId })
      if (entries.length === 0) {
        console.log('nothing in the dead-letter queue')
        break
      }
      for (const entry of entries) {
        console.log(`${entry.id}  ${entry.reason.padEnd(20)} ${entry.nodeId ?? ''} (${entry.errorClass ?? '?'})`)
      }
      break
    }

    case 'replay': {
      const [entryId] = args
      if (entryId === undefined) fail(USAGE)
      const result = await withTransaction(pool, (tx) => replayDlqEntry(tx, entryId, 'cli'))
      console.log(`replaying run ${result.run.id} from ${result.reset[0]}`)
      console.log(`attempt group ${result.attemptGroup} — new idempotency keys`)
      break
    }

    case 'health': {
      const health = await partitionHealth(pool)
      let sick = false
      for (const entry of health) {
        const mark = entry.healthy ? 'ok  ' : 'WARN'
        console.log(`${mark} ${entry.table.padEnd(18)} ${entry.daysAhead} day(s) of partitions ahead`)
        if (!entry.healthy) sick = true
      }
      if (sick) {
        console.error('\npg_partman maintenance may not be running. When the window closes,')
        console.error('every insert fails at once — there is no default partition to catch them.')
        process.exitCode = 1
      }
      break
    }

    default:
      console.log(USAGE)
      process.exitCode = command === undefined ? 0 : 1
  }
} finally {
  await pool.end()
}

async function printStatus(runId: string, startedAt: Date): Promise<void> {
  const run = await getRun(pool, startedAt, runId)
  if (run === null) fail(`no run ${runId} at ${startedAt.toISOString()}`)

  console.log(`\nstatus  ${run.status}`)
  if (run.errorClass !== null) console.log(`error   ${run.errorClass} at ${run.errorCode ?? '?'}`)
  if (run.cancelledAtStepId !== null) console.log(`stopped at ${run.cancelledAtStepId}`)

  const steps = await listSteps(pool, { id: run.id, startedAt: run.startedAt })
  console.log('')
  for (const step of steps) {
    const attempts = step.attemptsStarted > 1 ? `  (${step.attemptsStarted} attempts)` : ''
    const error = step.errorClass === null ? '' : `  ${step.errorClass}`
    console.log(`  ${step.status.padEnd(20)} ${step.nodeId}${attempts}${error}`)
  }
}
