# automa-flow-canvas

A drag-and-drop editor for building multi-step automations — the visual half of a workflow platform, running standalone against mock data.

> **Status:** in development. Part of the [AutomaBuild](https://github.com/codew3y/AutomaBuild) workflow-automation platform (component D of four).

**[Live demo →](#)** *(link once deployed)*

---

## What it is

The canvas you would recognise from Zapier, Make or n8n: boxes for steps, arrows for order, a panel to configure the selected step, and a mapping tool for wiring one step's output into the next one's input.

It runs entirely against mock data. There is no engine behind it — that is [automa-durable-runner](https://github.com/codew3y/automa-durable-runner). Keeping them apart is deliberate: a graph editor is a hard *state management* problem and it is worth solving on its own.

## What's interesting about it

Anyone can put React Flow on a page. The parts that take the time:

**Editing a graph is not editing a form.** Node positions, edge connections, per-node config and selection all change at different rates. Selection changes on every click; positions change 60 times a second during a drag. Keeping those in one store means the whole canvas re-renders while you drag one box. They are split into three stores so each part re-renders only when its own data moves.

**Undo has to match intent, not keystrokes.** Naively wiring undo to state changes gives you 200 history entries for one drag, and panning the canvas becomes undoable. History is debounced, viewport and selection are excluded, and one *user action* — "add node", including the edge it auto-connects — is one undo step.

**Invalid graphs are prevented, not reported.** Cycles are detected on the candidate graph *while you are dragging the connection*, so an edge that would create a loop never gets created. Problems that cannot be prevented — an unreachable node, a required field left empty, an expression referencing a step that does not run before it — surface as a badge on the node and a line in a Problems panel, and they block publishing.

**Autosave, but explicit publish.** Edits save continuously as a draft; the live version only changes when you press Publish. Published versions are immutable and numbered, so a run in progress is never affected by an edit. n8n, Retool and Zapier all landed on this same shape independently.

**Mapping needs live feedback.** A field picker showing the previous step's output as a tree, drag a value in, and see the resolved result immediately against real sample data. Without the preview it is guesswork.

## Stack

React 19 · TypeScript · [@xyflow/react](https://reactflow.dev) v12 · Zustand + zundo (undo/redo) · JSONata (expressions) · Vite · Tailwind

## Running it

```bash
pnpm install
pnpm dev
```

No backend required.

## License

MIT
