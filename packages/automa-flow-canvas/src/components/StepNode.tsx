/**
 * A step on the canvas.
 *
 * `memo` is not an optimisation here, it is a requirement. React Flow
 * re-renders the node layer on every viewport change, so an unmemoised node
 * component re-renders on every frame of a pan — with 150 nodes that is 150
 * component renders per frame, and the canvas visibly stutters.
 *
 * Equally important and easier to get wrong: the `nodeTypes` object passed to
 * `<ReactFlow>` must be declared *outside* the component that renders it. An
 * object literal in the render body is a new reference every time, React Flow
 * treats it as a new set of types, and every node unmounts and remounts. The
 * symptom is losing focus mid-typing and animations restarting for no reason.
 * See `nodeTypes` at the bottom of this file.
 */

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

export interface StepNodeData extends Record<string, unknown> {
  readonly label?: string
  readonly kind: string
  /** Validation problems attached to this node, for the outline and the badge. */
  readonly issueCount?: number
  readonly hasError?: boolean
  /** The problems themselves, so the node can say what is wrong with it. */
  readonly issues?: readonly string[]
  /** Set only in the run viewer. */
  readonly outcome?: string
  readonly durationMs?: number
}

/**
 * Node colours, as references into the stylesheet rather than literals.
 *
 * A hex here cannot follow the theme: the same violet that reads well on white
 * is muddy on a near-black canvas, so hard-coding one means every tile is
 * wrong in one of the two modes. The tokens are defined per theme in app.css.
 */
export const KIND_ACCENT: Record<string, string> = {
  trigger: 'var(--kind-trigger)',
  http: 'var(--kind-http)',
  ai: 'var(--kind-ai)',
  transform: 'var(--kind-transform)',
  branch: 'var(--kind-branch)',
  email: 'var(--kind-email)',
}

const KIND_STYLE: Record<string, { accent: string; glyph: string }> = {
  trigger: { accent: 'var(--kind-trigger)', glyph: '▶' },
  http: { accent: 'var(--kind-http)', glyph: '↗' },
  ai: { accent: 'var(--kind-ai)', glyph: '✦' },
  transform: { accent: 'var(--kind-transform)', glyph: 'ƒ' },
  branch: { accent: 'var(--kind-branch)', glyph: '⑂' },
  email: { accent: 'var(--kind-email)', glyph: '✉' },
}

/** One problem per line in the tooltip. */
const NEWLINE = String.fromCharCode(10)

function StepNodeComponent({ data, selected, id }: NodeProps) {
  const stepData = data as StepNodeData
  const style = KIND_STYLE[stepData.kind] ?? { accent: 'var(--muted)', glyph: '•' }
  const isTrigger = stepData.kind === 'trigger'
  const isBranch = stepData.kind === 'branch'

  return (
    <div
      className="step-node"
      data-selected={selected ? 'true' : undefined}
      data-error={stepData.hasError ? 'true' : undefined}
      data-warn={
        !stepData.hasError && (stepData.issueCount ?? 0) > 0 ? 'true' : undefined
      }
      data-outcome={stepData.outcome}
      // The problems, on hover. With no validation panel left, the node is the
      // only place that can say why it is red — and a red box with no
      // explanation is worse than no colour at all.
      title={
        stepData.issues !== undefined && stepData.issues.length > 0
          ? stepData.issues.join(NEWLINE)
          : undefined
      }
      style={{ '--accent': style.accent } as React.CSSProperties}
    >
      {/* A trigger has no input: nothing runs before it, so offering a target
          handle would invite a connection the graph cannot accept. */}
      {!isTrigger && <Handle type="target" position={Position.Left} />}

      <span className="step-glyph" aria-hidden="true">
        {style.glyph}
      </span>
      <span className="step-body">
        <span className="step-label">{stepData.label ?? id}</span>
        <span className="step-kind">{stepData.kind}</span>
      </span>

      {stepData.outcome !== undefined && (
        <span className={`step-outcome outcome-${stepData.outcome}`}>
          {stepData.outcome === 'succeeded'
            ? '✓'
            : stepData.outcome === 'failed'
              ? '✕'
              : stepData.outcome === 'not_reached'
                ? '–'
                : '…'}
          {stepData.durationMs !== undefined && (
            <span className="step-ms">{stepData.durationMs}ms</span>
          )}
        </span>
      )}

      {/* The badge has no title of its own: the node already carries the
          problems, and a tooltip here saying only how many would replace them
          on hover. */}
      {stepData.issueCount !== undefined && stepData.issueCount > 0 && (
        <span className="step-badge">{stepData.issueCount}</span>
      )}

      {isBranch ? (
        <>
          <Handle type="source" position={Position.Right} id="yes" style={{ top: '35%' }} />
          <Handle type="source" position={Position.Right} id="no" style={{ top: '65%' }} />
        </>
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  )
}

export const StepNode = memo(StepNodeComponent)

/**
 * Declared once, at module scope.
 *
 * Moving this inside a component — even as a `useMemo` that someone later
 * "simplifies" — remounts every node on every render.
 */
export const nodeTypes = { step: StepNode } as const
