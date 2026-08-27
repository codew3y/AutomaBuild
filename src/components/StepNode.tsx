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
}

const KIND_STYLE: Record<string, { accent: string; glyph: string }> = {
  trigger: { accent: '#7c3aed', glyph: '▶' },
  http: { accent: '#0ea5e9', glyph: '↗' },
  transform: { accent: '#f59e0b', glyph: 'ƒ' },
  branch: { accent: '#10b981', glyph: '⑂' },
  email: { accent: '#ec4899', glyph: '✉' },
}

function StepNodeComponent({ data, selected, id }: NodeProps) {
  const stepData = data as StepNodeData
  const style = KIND_STYLE[stepData.kind] ?? { accent: '#64748b', glyph: '•' }
  const isTrigger = stepData.kind === 'trigger'
  const isBranch = stepData.kind === 'branch'

  return (
    <div
      className="step-node"
      data-selected={selected ? 'true' : undefined}
      data-error={stepData.hasError ? 'true' : undefined}
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

      {stepData.issueCount !== undefined && stepData.issueCount > 0 && (
        <span
          className="step-badge"
          title={`${stepData.issueCount} problem${stepData.issueCount === 1 ? '' : 's'}`}
        >
          {stepData.issueCount}
        </span>
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
