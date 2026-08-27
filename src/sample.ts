/**
 * The flow the editor opens with, and the per-kind schemas.
 *
 * Deliberately contains a real validation error — the `notify` step refers to
 * a step on the other branch — so the validation panel has something to show
 * on first load rather than being an empty box nobody notices.
 */

import type { FlowGraph } from './core/graph.ts'

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
