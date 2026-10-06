import { createContext, useContext } from 'react'

/** The page-level panel on the right (a session's project context) belongs to the window, so the page asks for it here. */
export interface Layout {
  inspOpen: boolean
  toggleInsp: () => void
  /** where the inspector draws, once the window has made room for it */
  inspRoot: HTMLElement | null
  narrow: boolean
}
export const LayoutCtx = createContext<Layout>({ inspOpen: false, toggleInsp: () => {}, inspRoot: null, narrow: false })
export const useLayout = () => useContext(LayoutCtx)
