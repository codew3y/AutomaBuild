/**
 * The editor store — everything that is *not* undoable.
 *
 * Selection, viewport, which panel tab is open, whether the palette is
 * showing. All of it is state, none of it is the document, and keeping it in a
 * separate store is what makes `partialize` in the graph store honest: there
 * is no way for a viewport change to reach the undo stack because it never
 * enters the store that has one.
 *
 * The alternative — one store with careful partialize — works until someone
 * adds a field and forgets. This way the boundary is structural.
 */

import { createStore } from 'zustand/vanilla'

export interface Viewport {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

export type PanelTab = 'setup' | 'mapping'

/** Editing the flow, or looking at an execution that already happened. */
export type Mode = 'edit' | 'run'

export interface EditorState {
  readonly selectedNodeId: string | null
  /**
   * Whether each side panel is showing.
   *
   * Here rather than in the graph store, like every other piece of view state:
   * collapsing a panel is not an edit, and it must never appear in the undo
   * stack. Someone who hides the library and then presses ctrl-Z expects their
   * last *edit* back, not the panel.
   */
  /**
   * The setup field that last had focus, and the step it belongs to.
   *
   * Deliberately not cleared on blur. Clicking a field in the mapping panel
   * blurs the input first — mousedown, blur, then click — so clearing on blur
   * would forget the target before the insert ever happened, and every click
   * would silently do nothing.
   */
  readonly focusedField: { readonly nodeId: string; readonly field: string } | null
  readonly leftPanelOpen: boolean
  readonly rightPanelOpen: boolean
  readonly viewport: Viewport
  readonly panelTab: PanelTab
  readonly paletteOpen: boolean
  readonly mode: Mode

  select(nodeId: string | null): void
  focusField(nodeId: string, field: string): void
  clearFocusedField(): void
  toggleLeftPanel(): void
  toggleRightPanel(): void
  setViewport(viewport: Viewport): void
  setPanelTab(tab: PanelTab): void
  togglePalette(): void
  setMode(mode: Mode): void
}

export const createEditorStore = () =>
  createStore<EditorState>()((set) => ({
    selectedNodeId: null,
    focusedField: null,
    leftPanelOpen: true,
    // Closed by default: mapping moved into the setup dialog, so nothing in
    // this panel is needed to build a flow. What remains is validation and the
    // run viewer, both worth reaching deliberately.
    rightPanelOpen: false,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelTab: 'setup',
    paletteOpen: true,
    mode: 'edit',

    select(nodeId) {
      set({ selectedNodeId: nodeId })
    },
    focusField(nodeId, field) {
      set({ focusedField: { nodeId, field } })
    },
    clearFocusedField() {
      set({ focusedField: null })
    },
    toggleLeftPanel() {
      set((state) => ({ leftPanelOpen: !state.leftPanelOpen }))
    },
    toggleRightPanel() {
      set((state) => ({ rightPanelOpen: !state.rightPanelOpen }))
    },
    setViewport(viewport) {
      set({ viewport })
    },
    setPanelTab(panelTab) {
      set({ panelTab })
    },
    togglePalette() {
      set((state) => ({ paletteOpen: !state.paletteOpen }))
    },
    setMode(mode) {
      // Selection is cleared when switching, because the two modes select
      // different things — a step you are configuring, versus a step whose
      // result you are reading — and carrying one over shows the wrong panel.
      set({ mode, selectedNodeId: null })
    },
  }))

export type EditorStore = ReturnType<typeof createEditorStore>
