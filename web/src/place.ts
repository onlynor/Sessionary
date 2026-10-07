/** Where floating things (menus, popovers) go. Pure, so it is tested without a browser (test/ui.test.ts). */

const EDGE = 8 // the closest a menu comes to the window's edge

/** where a menu of this size goes: on screen, flipped to the roomier side of its opener, scrolling if it cannot fit */
export function placeMenu(at: { left: number; top?: number; bottom?: number }, size: { w: number; h: number }, anchor?: { top: number; bottom: number }, view = { w: innerWidth, h: innerHeight }) {
  const w = Math.min(size.w, view.w - EDGE * 2)
  const left = Math.max(EDGE, Math.min(at.left, view.w - w - EDGE))
  if (at.bottom != null) {
    // opening upwards from a point (the sidebar's foot)
    const room = view.h - at.bottom - EDGE
    return { left, width: w, bottom: at.bottom, maxHeight: Math.max(120, room) }
  }
  const top = at.top ?? EDGE
  const below = view.h - top - EDGE
  if (size.h <= below) return { left, width: w, top, maxHeight: below }
  const above = (anchor ? anchor.top - 6 : top) - EDGE
  if (anchor && above > below) return { left, width: w, bottom: view.h - anchor.top + 6, maxHeight: above }
  // no opener to flip around: move up as far as needed, then scroll inside
  const t = Math.max(EDGE, Math.min(top, view.h - EDGE - size.h))
  return { left, width: w, top: t, maxHeight: view.h - t - EDGE }
}
