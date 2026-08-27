/**
 * The flow the demo runs.
 *
 * In the canvas's own shape, because that is the point: this is a document the
 * editor could have produced, and the server compiles it rather than being
 * handed an engine flow definition directly. Swapping this for a graph
 * exported from the editor changes nothing else.
 *
 * The URLs are real and public. A step pointing at `localhost` would be
 * refused by `automa-safe-fetch` — correctly, since a flow URL comes from a
 * user and pointing one at a loopback or metadata address is the SSRF this
 * whole system is built to prevent — so a demo cannot call its own server, and
 * pretending otherwise would mean turning the protection off to show it
 * working.
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
        // A public repository, so the call needs no credentials. It was
        // pointed at this project's own repository first, which 404s while
        // that repository is private — a demo whose success depends on the
        // author's access settings is a demo that breaks for everyone else.
        url: 'https://api.github.com/repos/nodejs/node',
        method: 'GET',
      },
    },
    {
      id: 'record',
      kind: 'http',
      position: { x: 500, y: 160 },
      data: {
        label: 'Record the result',
        // A mapped URL, so the run proves the editor's `{{ }}` references
        // resolve against real upstream output rather than only in the
        // preview. `full_name` comes from the step before it.
        url: 'https://api.github.com/repos/{{ steps.lookup.output.body.full_name }}/languages',
        method: 'GET',
      },
    },
  ],
  edges: [
    { id: 'trigger->lookup', source: 'trigger', target: 'lookup' },
    { id: 'lookup->record', source: 'lookup', target: 'record' },
  ],
}
