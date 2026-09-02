/**
 * Publish-time validation.
 *
 * Two rules here are cheap to state and easy to omit, and omitting them means
 * the flow fails at *run* time instead — by which point it has already done
 * half its work, possibly to somebody's real data.
 *
 * **A reference to a non-ancestor step.** `{{ steps.send_email.output.id }}`
 * in a step that does not run after `send_email` is not a typo the engine can
 * recover from: at the moment that expression is evaluated the value does not
 * exist and never will. It reads as valid — the step is real, the field is
 * plausible — and only the *graph position* makes it wrong. On a branch it is
 * worse: the referenced step exists on the other branch, so it resolves in
 * testing and is empty in production whenever the other path is taken.
 *
 * **An orphan.** A node with no path from the trigger never runs. Nothing
 * errors; the work silently does not happen, which is the failure mode people
 * take longest to notice.
 */

import { ancestors, danglingEdges, orphans, roots, topologicalOrder, type FlowGraph } from './graph.ts'

export type Severity = 'error' | 'warning'

export interface ValidationIssue {
  readonly severity: Severity
  readonly code: string
  readonly message: string
  /** Which node to highlight. Undefined for a whole-graph problem. */
  readonly nodeId?: string
  /** Which field within the node's config, for the panel to focus. */
  readonly field?: string
}

export interface NodeSchema {
  /** Fields that must be present and non-empty before publishing. */
  readonly required?: readonly string[]
  readonly label?: string
}

export interface ValidationContext {
  /** Per-kind schema, for the required-field check. */
  readonly schemas?: Readonly<Record<string, NodeSchema>>
}

/** `{{ steps.<id>.… }}` — the only reference form v1 supports. */
const STEP_REFERENCE = /\{\{\s*steps\.([A-Za-z0-9_-]+)/g

export function referencedSteps(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const found: string[] = []
  for (const match of value.matchAll(STEP_REFERENCE)) {
    if (match[1] !== undefined) found.push(match[1])
  }
  return found
}

/** Walk a config object collecting every `{{ steps.x }}` with its field path. */
function collectReferences(
  data: Readonly<Record<string, unknown>>,
  prefix = '',
): Array<{ field: string; stepId: string }> {
  const found: Array<{ field: string; stepId: string }> = []

  for (const [key, value] of Object.entries(data)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') {
      for (const stepId of referencedSteps(value)) found.push({ field: path, stepId })
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (typeof item === 'string') {
          for (const stepId of referencedSteps(item)) {
            found.push({ field: `${path}[${index}]`, stepId })
          }
        } else if (item !== null && typeof item === 'object') {
          found.push(
            ...collectReferences(item as Record<string, unknown>, `${path}[${index}]`),
          )
        }
      }
    } else if (value !== null && typeof value === 'object') {
      found.push(...collectReferences(value as Record<string, unknown>, path))
    }
  }

  return found
}

export function validate(graph: FlowGraph, context: ValidationContext = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))

  if (graph.nodes.length === 0) {
    return [{ severity: 'error', code: 'empty_flow', message: 'A flow needs at least one step.' }]
  }

  // Structure first: everything below assumes the graph is walkable.
  for (const edge of danglingEdges(graph)) {
    issues.push({
      severity: 'error',
      code: 'dangling_edge',
      message: `Edge ${edge.id} points at a step that no longer exists.`,
    })
  }

  if (topologicalOrder(graph) === null) {
    issues.push({
      severity: 'error',
      code: 'cycle',
      message: 'The flow contains a loop, so it has no order to run in.',
    })
    // Ancestry is meaningless in a cyclic graph, so stop before the reference
    // check reports nonsense on top of a problem already reported.
    return issues
  }

  const entryPoints = roots(graph)
  if (entryPoints.length === 0) {
    issues.push({
      severity: 'error',
      code: 'no_trigger',
      message: 'Every step has an input, so nothing starts the flow.',
    })
  } else if (entryPoints.length > 1) {
    issues.push({
      severity: 'error',
      code: 'multiple_triggers',
      message: `${entryPoints.length} steps have no input. A flow has exactly one starting point.`,
      nodeId: entryPoints[1]!.id,
    })
  }

  for (const node of orphans(graph)) {
    // A warning rather than an error: mid-edit this is normal, and blocking a
    // save on it would make the editor hostile. Publishing is where it counts.
    issues.push({
      severity: 'warning',
      code: 'orphan',
      message: `"${label(node.id, context)}" is not connected to the flow, so it will never run.`,
      nodeId: node.id,
    })
  }

  for (const node of graph.nodes) {
    const schema = context.schemas?.[node.kind]
    for (const field of schema?.required ?? []) {
      const value = node.data[field]
      if (value === undefined || value === null || value === '') {
        issues.push({
          severity: 'error',
          code: 'missing_required',
          message: `"${label(node.id, context)}" needs ${field}.`,
          nodeId: node.id,
          field,
        })
      }
    }

    // The subtle one.
    const available = ancestors(graph, node.id)
    for (const reference of collectReferences(node.data)) {
      if (reference.stepId === node.id) {
        issues.push({
          severity: 'error',
          code: 'self_reference',
          message: `"${label(node.id, context)}" refers to its own output, which does not exist yet when it runs.`,
          nodeId: node.id,
          field: reference.field,
        })
        continue
      }

      if (!byId.has(reference.stepId)) {
        issues.push({
          severity: 'error',
          code: 'unknown_reference',
          message: `"${label(node.id, context)}" refers to ${reference.stepId}, which is not in this flow.`,
          nodeId: node.id,
          field: reference.field,
        })
        continue
      }

      if (!available.has(reference.stepId)) {
        issues.push({
          severity: 'error',
          code: 'non_ancestor_reference',
          message:
            `"${label(node.id, context)}" refers to "${label(reference.stepId, context)}", ` +
            `which does not run before it. On a branch this resolves while testing and is ` +
            `empty in production whenever the other path is taken.`,
          nodeId: node.id,
          field: reference.field,
        })
      }
    }
  }

  return issues
}

function label(nodeId: string, context: ValidationContext): string {
  return context.schemas?.[nodeId]?.label ?? nodeId
}

/** Publishing is blocked by errors. Warnings are shown and do not block. */
export function canPublish(issues: readonly ValidationIssue[]): boolean {
  return !issues.some((issue) => issue.severity === 'error')
}

/** Issues grouped by node, for highlighting on the canvas. */
export function issuesByNode(
  issues: readonly ValidationIssue[],
): Map<string, ValidationIssue[]> {
  const map = new Map<string, ValidationIssue[]>()
  for (const issue of issues) {
    if (issue.nodeId === undefined) continue
    const list = map.get(issue.nodeId) ?? []
    list.push(issue)
    map.set(issue.nodeId, list)
  }
  return map
}
