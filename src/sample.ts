/**
 * The flow the editor opens with, and the per-kind schemas.
 *
 * Deliberately contains a real validation error — the `notify` step refers to
 * a step on the other branch — so the validation panel has something to show
 * on first load rather than being an empty box nobody notices.
 */

import type { FlowGraph } from './core/graph.ts'
import type { RunRecord } from './core/run.ts'

export const STEP_KINDS = ['http', 'transform', 'branch', 'email'] as const

export interface StepSchema {
  readonly fields: readonly string[]
  readonly required?: readonly string[]
  readonly label?: string
}

export const SCHEMAS: Record<string, StepSchema> = {
  trigger: { fields: ['event'], label: 'Trigger' },
  http: { fields: ['url', 'method'], required: ['url'], label: 'HTTP request' },
  transform: { fields: ['expression'], label: 'Transform' },
  branch: { fields: ['condition'], required: ['condition'], label: 'Branch' },
  email: { fields: ['to', 'subject'], required: ['to'], label: 'Send email' },
}

export const SAMPLE_FLOW: FlowGraph = {
  nodes: [
    { id: 'trigger', kind: 'trigger', position: { x: 0, y: 160 }, data: { label: 'Webhook received', event: 'invoice.paid' } },
    { id: 'fetch', kind: 'http', position: { x: 220, y: 160 }, data: { label: 'Fetch customer', url: 'https://api.example.com/customers/1', method: 'GET' } },
    { id: 'check', kind: 'branch', position: { x: 460, y: 160 }, data: { label: 'Is premium?', condition: '{{ steps.fetch.output.tier }} = "premium"' } },
    { id: 'thanks', kind: 'email', position: { x: 700, y: 60 }, data: { label: 'Thank-you email', to: '{{ steps.fetch.output.email }}', subject: 'Thanks!' } },
    { id: 'notify', kind: 'email', position: { x: 700, y: 280 }, data: { label: 'Notify sales', to: '{{ steps.thanks.output.messageId }}', subject: 'New signup' } },
  ],
  edges: [
    { id: 'trigger->fetch', source: 'trigger', target: 'fetch' },
    { id: 'fetch->check', source: 'fetch', target: 'check' },
    { id: 'check->thanks:yes', source: 'check', target: 'thanks', sourceHandle: 'yes' },
    { id: 'check->notify:no', source: 'check', target: 'notify', sourceHandle: 'no' },
  ],
}

/**
 * What each step produced, for the mapping preview.
 *
 * Sample data rather than live data, since this project has no backend by
 * design. The shapes are the ones a real provider would return, because a
 * preview against invented shapes teaches the wrong field names.
 */
export const SAMPLE_OUTPUTS: Record<string, { output: unknown }> = {
  trigger: {
    output: {
      event: 'invoice.paid',
      receivedAt: '2026-03-01T09:14:02Z',
      body: { invoiceId: 'in_9f2', amount: 4200, currency: 'chf' },
    },
  },
  fetch: {
    output: {
      id: 'cus_4821',
      email: 'sam@example.com',
      name: 'Sam Rivera',
      tier: 'premium',
      credits: 0,
      active: true,
      address: { city: 'Zurich', country: 'CH' },
      orders: [{ id: 'ord_1', total: 42, placedAt: '2026-02-11' }],
    },
  },
  check: { output: { branch: 'yes', matched: true } },
  thanks: { output: { messageId: 'msg_77a', accepted: true } },
}

/**
 * A past execution, for the run viewer.
 *
 * Carries its own copy of the graph, because a run belongs to the version it
 * ran on — rendering it against the current design would mean debugging
 * yesterday's failure on today's diagram.
 */
export const SAMPLE_RUN: RunRecord = {
  id: 'run_2f81',
  startedAt: '2026-03-01T09:14:02Z',
  status: 'succeeded',
  graph: SAMPLE_FLOW,
  steps: [
    {
      nodeId: 'trigger',
      outcome: 'succeeded',
      durationMs: 4,
      output: SAMPLE_OUTPUTS.trigger!.output,
    },
    {
      nodeId: 'fetch',
      outcome: 'succeeded',
      durationMs: 318,
      attempts: 2,
      input: { url: 'https://api.example.com/customers/1', method: 'GET' },
      output: SAMPLE_OUTPUTS.fetch!.output,
    },
    {
      nodeId: 'check',
      outcome: 'succeeded',
      durationMs: 1,
      input: { condition: 'tier = "premium"' },
      output: SAMPLE_OUTPUTS.check!.output,
    },
    {
      nodeId: 'thanks',
      outcome: 'succeeded',
      durationMs: 142,
      input: { to: 'sam@example.com', subject: 'Thanks!' },
      output: SAMPLE_OUTPUTS.thanks!.output,
    },
    // The step the branch skipped. This is the case the viewer exists to make
    // visible: nothing failed, and the email simply never went out.
    { nodeId: 'notify', outcome: 'not_reached' },
  ],
}
