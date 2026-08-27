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

export type PanelTab = 'setup' | 'mapping' | 'test' | 'settings'

export interface EditorState {
  readonly selectedNodeId: string | null
  readonly viewport: Viewport
  readonly panelTab: PanelTab
  readonly paletteOpen: boolean

  select(nodeId: string | null): void
  setViewport(viewport: Viewport): void
  setPanelTab(tab: PanelTab): void
  togglePalette(): void
}

export const createEditorStore = () =>
  createStore<EditorState>()((set) => ({
    selectedNodeId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelTab: 'setup',
    paletteOpen: true,

    select(nodeId) {
      set({ selectedNodeId: nodeId })
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
  }))

export type EditorStore = ReturnType<typeof createEditorStore>
