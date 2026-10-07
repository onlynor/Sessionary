import assert from 'node:assert/strict'
import { test } from 'node:test'
import { placeMenu } from '../web/src/place.ts'

const inView = (p: ReturnType<typeof placeMenu>, view: { w: number; h: number }, h: number) => {
  const height = Math.min(h, p.maxHeight)
  const top = p.top ?? view.h - p.bottom! - height
  return p.left >= 8 && p.left + p.width <= view.w - 8 && top >= 8 && top + height <= view.h - 8
}

test('a menu is placed wholly on screen, whatever the window and the opener', () => {
  const sizes = [{ w: 1440, h: 900 }, { w: 900, h: 520 }, { w: 700, h: 360 }, { w: 380, h: 300 }]
  for (const view of sizes)
    for (const menu of [{ w: 240, h: 420 }, { w: 420, h: 520 }, { w: 200, h: 120 }])
      for (const at of [{ x: 0.05, y: 0.1 }, { x: 0.95, y: 0.3 }, { x: 0.6, y: 0.85 }]) {
        const anchor = { top: view.h * at.y - 30, bottom: view.h * at.y }
        const p = placeMenu({ left: view.w * at.x - menu.w, top: anchor.bottom + 6 }, menu, anchor, view)
        assert.ok(inView(p, view, menu.h), `${JSON.stringify({ view, menu, at, p })}`)
      }
})

test('a menu goes below its opener when it fits, flips above when that side has more room, scrolls when neither fits', () => {
  const view = { w: 900, h: 520 }
  const below = placeMenu({ left: 600, top: 106 }, { w: 240, h: 300 }, { top: 70, bottom: 100 }, view)
  assert.equal(below.top, 106)
  const flipped = placeMenu({ left: 600, top: 296 }, { w: 240, h: 420 }, { top: 260, bottom: 290 }, view)
  assert.equal(flipped.top, undefined)
  assert.equal(flipped.bottom, view.h - 260 + 6) // just above the opener
  assert.ok(flipped.maxHeight < 420) // and it scrolls inside
  // opening upwards from a point (the sidebar's foot) is capped to the room above it
  const up = placeMenu({ left: 10, bottom: 40 }, { w: 260, h: 900 }, undefined, view)
  assert.equal(up.maxHeight, view.h - 40 - 8)
})
