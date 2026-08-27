/**
 * The flow the demo runs, and the one a fresh database is seeded with.
 *
 * In the canvas's own shape, because that is the point: this is a document the
 * editor could have produced, and the server compiles it rather than being
 * handed an engine flow definition directly. Publishing a graph from the
 * editor replaces it and changes nothing else.
 *
 * It uses every step kind on purpose — a webhook arrives, an API is called, the
 * two are reshaped into one object, and that object is emailed. Anything less
 * would leave a step type unexercised by the one thing that runs in CI.
 *
 * The URL is real and public. A step pointing at `localhost` would be refused
 * by `automa-safe-fetch` — correctly, since a flow URL comes from a user and
 * pointing one at a loopback or metadata address is the SSRF this whole system
 * exists to prevent — so the demo cannot call its own server, and turning the
 * protection off to show it working would defeat the point.
 */

import type { CanvasGraph } from './flow.ts'

export const DEMO_FLOW: CanvasGraph = {
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
        // A public repository, so the call needs no credentials. It pointed at
        // this project's own repository first, which 404s while that is
        // private — a demo whose success depends on the author's access
        // settings is a demo that breaks for everyone else.
        url: 'https://api.github.com/repos/nodejs/node',
        method: 'GET',
      },
    },
    {
      id: 'shape',
      kind: 'transform',
      position: { x: 480, y: 160 },
      data: {
        label: 'Build the summary',
        // Two sources combined into one object: the API response and the
        // webhook payload that started the run. `stars` and `amount` come back
        // as numbers, not as text — the transform parses the template before
        // resolving so a referenced type survives.
        template: [
          '{',
          '  "repo": "{{ steps.lookup.output.body.full_name }}",',
          '  "stars": "{{ steps.lookup.output.body.stargazers_count }}",',
          '  "amount": "{{ trigger.body.data.object.amount_paid }}",',
          '  "currency": "{{ trigger.body.data.object.currency }}"',
          '}',
        ].join('\n'),
      },
    },
    {
      id: 'notify',
      kind: 'email',
      position: { x: 720, y: 160 },
      data: {
        label: 'Send the summary',
        // .test is reserved by RFC 2606 and can never be a real domain, so a
        // misconfigured relay cannot deliver this to a person by accident.
        to: 'finance@example.test',
        subject: 'Invoice paid — {{ steps.shape.output.repo }}',
        body: [
          'An invoice was paid.',
          '',
          'Repository: {{ steps.shape.output.repo }}',
          'Stars:      {{ steps.shape.output.stars }}',
          'Amount:     {{ steps.shape.output.amount }} {{ steps.shape.output.currency }}',
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
