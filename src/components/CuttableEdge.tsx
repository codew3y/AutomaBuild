/**
 * An edge you can cut.
 *
 * React Flow will delete a selected edge on a keypress, which requires knowing
 * that an edge can be selected and which key does it. Hovering and clicking a
 * pair of scissors requires knowing neither, and the affordance appears exactly
 * where the act would happen.
 *
 * The scissors live in an `EdgeLabelRenderer` portal rather than inside the
 * SVG, because SVG has no layout: positioning a button on a bezier means
 * computing a point on the curve, and React Flow already computes that for the
 * label. The portal renders it as ordinary HTML at that point.
 */

import { memo, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";

function CuttableEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  selected,
  deletable,
}: EdgeProps) {
  /*
    `deleteElements`, not `setEdges`.

    The graph is controlled — App owns it in a Zustand store and feeds React
    Flow the result. Writing to React Flow's own copy would be undone by the
    next render from props. `deleteElements` goes through `onEdgesChange`,
    which is where App already handles removals.
  */
  const { deleteElements } = useReactFlow();

  /*
    Hover is tracked here rather than in CSS.

    `EdgeLabelRenderer` portals the scissors into a container of its own,
    outside this edge's SVG group, so no descendant selector reaches from one
    to the other. Both halves report into the same piece of state instead —
    which also keeps the scissors visible while the pointer is on them, having
    just left the line.
  */
  const [hovered, setHovered] = useState(false);

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />

      {/*
        A fat transparent copy of the line, purely to be hovered. The visible
        edge is 1.5px wide, which is a hard thing to put a pointer on.
      */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="edge-hit"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />

      <EdgeLabelRenderer>
        <div
          className={
            hovered || selected === true ? "edge-tools shown" : "edge-tools"
          }
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            // `pointer-events: all` is set in CSS on the button rather than
            // here: the wrapper must stay transparent to the pointer or it
            // would sit over the canvas and swallow pans.
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          {label !== undefined && label !== "" && (
            <span className="edge-label">{label}</span>
          )}

          {/* No scissors on an edge that cannot be cut. While a past run is
              on screen the graph is a record, not a draft, and offering a
              control that declines to act is worse than not offering it. */}
          {deletable !== false && (
            <button
              className="edge-cut"
              title="Cut this connection"
              aria-label="Cut this connection"
              onClick={(event) => {
                // Without this the click reaches the pane and clears the
                // selection, which is harmless but makes the button feel like it
                // did two things.
                event.stopPropagation();
                void deleteElements({ edges: [{ id }] });
              }}
            >
              ✂
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const CuttableEdge = memo(CuttableEdgeComponent);

/**
 * Declared at module scope, for the same reason `nodeTypes` is.
 *
 * An object literal in a render body is a new reference every time, which React
 * Flow reads as a new set of types — and every edge unmounts and remounts.
 */
export const edgeTypes = { cuttable: CuttableEdge } as const;
