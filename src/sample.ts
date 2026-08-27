/**
 * The flow the editor opens with, and the per-kind schemas.
 *
 * It used to contain a deliberate validation error and a branch, so that the
 * validation panel had something to show on first load. That made sense while
 * nothing could run. It stopped making sense the moment Publish did something:
 * pressing it on a fresh editor produced four errors, because the engine runs
 * a linear chain and the sample was branched. The first thing anyone did with
 * the finished product was watch it refuse its own example.
 *
 * The default is now a flow that publishes and runs: a webhook arrives, an API
 * is called, the two are reshaped, and the result is emailed. The branched
 * version is kept as `BRANCHED_SAMPLE` for the validation tests, which are
 * what actually needed it.
 */

import type { FlowGraph } from './core/graph.ts'
import type { RunRecord } from './core/run.ts'

export const STEP_KINDS = ['http', 'transform', 'branch', 'email'] as const

export interface StepSchema {
  readonly fields: readonly string[]
  readonly required?: readonly string[]
  readonly label?: string
  /**
   * Fields that need a textarea rather than a single line.
   *
   * The schema decides, not the input component. Guessing from the field name
   * works right up until a step has a `body` that is a URL fragment, and then
   * the guess is wrong in a way nobody can configure their way out of.
   */
  readonly multiline?: readonly string[]
}

export const SCHEMAS: Record<string, StepSchema> = {
  trigger: { fields: ['event'], label: 'Trigger' },
  http: { fields: ['url', 'method'], required: ['url'], label: 'HTTP request' },
  transform: {
    fields: ['template'],
    required: ['template'],
    label: 'Transform',
    multiline: ['template'],
  },
  branch: { fields: ['condition'], required: ['condition'], label: 'Branch' },
  email: {
    fields: ['to', 'subject', 'body'],
    required: ['to', 'body'],
    label: 'Send email',
    multiline: ['body'],
  },
}

/**
 * A flow that publishes and runs, straight out of the box.
 *
 * Every step kind that has an executor, in the order they make sense: the
 * webhook arrives, an API is called, the response and the payload are combined,
 * and the result is emailed. The URL is a real public endpoint so that pressing
 * Publish and sending a webhook actually does something.
 */
export const SAMPLE_FLOW: FlowGraph = {
  nodes: [
    {
      id: 'trigger',
      kind: 'trigger',
      position: { x: 0, y: 160 },
      data: { label: 'Webhook received', event: 'invoice.paid' },
    },
    {
      id: 'lookup',
      kind: 'http',
      position: { x: 240, y: 160 },
      data: {
        label: 'Look up the repository',
        url: 'https://api.github.com/repos/nodejs/node',
        method: 'GET',
      },
    },
    {
      id: 'shape',
      kind: 'transform',
      position: { x: 490, y: 160 },
      data: {
        label: 'Build the summary',
        template: [
          '{',
          '  "repo": "{{ steps.lookup.output.body.full_name }}",',
          '  "stars": "{{ steps.lookup.output.body.stargazers_count }}",',
          '  "amount": "{{ trigger.body.data.object.amount_paid }}"',
          '}',
        ].join('\n'),
      },
    },
    {
      id: 'notify',
      kind: 'email',
      position: { x: 740, y: 160 },
      data: {
        label: 'Send the summary',
        // .test is reserved by RFC 2606 and can never be a real domain, so the
        // example cannot reach a person by accident.
        to: 'finance@example.test',
        subject: 'Invoice paid — {{ steps.shape.output.repo }}',
        body: [
          'An invoice was paid.',
          '',
          'Repository: {{ steps.shape.output.repo }}',
          'Stars:      {{ steps.shape.output.stars }}',
          'Amount:     {{ steps.shape.output.amount }}',
        ].join('\n'),
      },
    },
  ],
  edges: [
    { id: 'trigger->lookup', source: 'trigger', target: 'lookup' },
    { id: 'lookup->shape', source: 'lookup', target: 'shape' },
    { id: 'shape->notify', source: 'shape', target: 'notify' },
  ],
}

/**
 * The old sample: branched, and containing a real non-ancestor reference.
 *
 * Kept because the validation tests are about exactly these two problems, and
 * inventing a fresh broken graph in each test would be a worse way to describe
 * them than pointing at one everybody can see.
 */
export const BRANCHED_SAMPLE: FlowGraph = {
  nodes: [
    { id: 'trigger', kind: 'trigger', position: { x: 0, y: 160 }, data: { label: 'Webhook received', event: 'invoice.paid' } },
    { id: 'fetch', kind: 'http', position: { x: 220, y: 160 }, data: { label: 'Fetch customer', url: 'https://api.example.com/customers/1', method: 'GET' } },
    { id: 'check', kind: 'branch', position: { x: 460, y: 160 }, data: { label: 'Is premium?', condition: '{{ steps.fetch.output.tier }} = "premium"' } },
    { id: 'thanks', kind: 'email', position: { x: 700, y: 60 }, data: { label: 'Thank-you email', to: '{{ steps.fetch.output.email }}', subject: 'Thanks!', body: `Hi {{ steps.fetch.output.name }},\n\nThanks for upgrading — your premium features are live.` } },
    { id: 'notify', kind: 'email', position: { x: 700, y: 280 }, data: { label: 'Notify sales', to: '{{ steps.thanks.output.messageId }}', subject: 'New signup', body: 'A new signup came through: {{ steps.fetch.output.email }}' } },
  ],
  edges: [
    { id: 'trigger->fetch', source: 'trigger', target: 'fetch' },
    { id: 'fetch->check', source: 'fetch', target: 'check' },
    { id: 'check->thanks:yes', source: 'check', target: 'thanks', sourceHandle: 'yes' },
    { id: 'check->notify:no', source: 'check', target: 'notify', sourceHandle: 'no' },
  ],
}

/**
 * What each step produced.
 *
 * Sample data, used when no backend is connected and as the floor underneath a
 * real run: the mapping panel merges the last run over this, so a flow that has
 * never run still shows fields rather than an empty tree. The shapes are the
 * ones the real providers return, because a preview against invented shapes
 * teaches the wrong field names.
 */
export const SAMPLE_OUTPUTS: Record<string, { output: unknown }> = {
  trigger: {
    output: {
      event: "invoice.paid",
      receivedAt: "2026-03-01T09:14:02Z",
      body: { data: { object: { amount_paid: 4200, currency: "chf" } } },
    },
  },
  lookup: {
    output: {
      status: 200,
      body: {
        full_name: "nodejs/node",
        stargazers_count: 119635,
        open_issues_count: 1743,
        language: "JavaScript",
        owner: { login: "nodejs", type: "Organization" },
      },
    },
  },
  shape: { output: { repo: "nodejs/node", stars: 119635, amount: 4200 } },
}

/**
 * A past execution, for the run viewer.
 *
 * Carries its own copy of the graph, because a run belongs to the version it
 * ran on — rendering it against the current design would mean debugging
 * yesterday's failure on today's diagram.
 *
 * The email step is left `not_reached`, which is the case the viewer exists to
 * make visible: nothing failed, and the message simply never went out.
 */
export const SAMPLE_RUN: RunRecord = {
  id: "run_2f81",
  startedAt: "2026-03-01T09:14:02Z",
  finishedAt: "2026-03-01T09:14:05Z",
  status: "failed",
  graph: SAMPLE_FLOW,
  steps: [
    {
      nodeId: "trigger",
      outcome: "succeeded",
      durationMs: 4,
      output: SAMPLE_OUTPUTS.trigger!.output,
    },
    {
      nodeId: "lookup",
      outcome: "succeeded",
      durationMs: 318,
      attempts: 2,
      input: { url: "https://api.github.com/repos/nodejs/node", method: "GET" },
      output: SAMPLE_OUTPUTS.lookup!.output,
    },
    {
      nodeId: "shape",
      outcome: "failed",
      durationMs: 6,
      error: "unresolved reference: steps.lookup.output.body.owner.email",
    },
    { nodeId: "notify", outcome: "not_reached" },
  ],
}
