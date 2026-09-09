/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Placement half of `drawing-markup-read.ts`'s read side — split out so
 * that module stays under the ~400 line house limit (`check-module-size.mjs`).
 *
 * Undoes, for one annotation's parsed 2D point, both distortions the write
 * → WASM-parse round trip introduces:
 *
 * 1. **The symbolic parser's plan-Y negation.** `rust/processing/src/
 *    symbolic/rebase.rs`'s `plan()` emits `(ifcX - rtc.x, -(ifcY - rtc.y))`
 *    — every point `symbolic-parse.ts` hands back is already Y-negated.
 * 2. **The annotation's full `ObjectPlacement` chain.** The writer
 *    (`packages/create/src/in-store/drawing-markup.ts`,
 *    `emitLocalPlacement(editor, anchor.storeyPlacementId, [0, 0, 0])`)
 *    always anchors an annotation's OWN local placement at identity under
 *    the target storey, and writes the caller's `(x, y)` verbatim at local
 *    `z = 0`. So the parsed point is the WORLD-frame image of that local
 *    point through the storey ← building ← site chain (translation AND
 *    rotation), not the point itself.
 *
 * `composeWorldPlacement(store, expressId)` (`../compare/worldPlacement.ts`)
 * composes that exact chain off the annotation's own express id — its own
 * identity local placement is just one more (harmless) hop in the
 * composition — and returns a row-major 4x4 in the file's NATIVE length
 * unit. Scaling its translation by `lengthUnitScale` puts it in the same
 * metres the symbolic parser's points are already in.
 *
 * With local `z = 0`, `world = T + xLocal·R[:,0] + yLocal·R[:,1]` — two
 * equations (world X, world Y) in the two unknowns `(xLocal, yLocal)`,
 * solved by inverting the top-left 2x2 of `R`. This recovers the authored
 * point exactly for translation, ANY in-plane (about-Z) rotation, and — so
 * long as that 2x2 is non-degenerate — an out-of-plane tilt too, since the
 * derivation never assumed `R` was a pure Z-rotation. It is NOT exact when
 * the model needed RTC re-basing (`rebase.rs`, only past a 10 km offset):
 * this reader has no visibility into that offset, so an RTC-shifted model's
 * markup would still be off by the shift — out of scope here, and no test
 * in this module exercises a large-coordinate fixture.
 *
 * Why the reader inverts rather than the writer compensating: the writer
 * (`drawing-markup.ts`) has no reason to know the reader's Y-negated,
 * fully-composed WORLD frame — its whole point is to place an
 * `IfcAnnotation` at ordinary, correct MODEL coordinates so any other IFC
 * tool that opens the file sees a sensibly-placed annotation. Pre-distorting
 * the writer's output to cancel a viewer-internal convention would make the
 * IFC file itself wrong for everyone else; the Y-negation and the parser's
 * frame are this reader's own business to undo.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { composeWorldPlacement, type PlacementComposeCache } from '../compare/worldPlacement.js';
import type { MarkupPoint2D } from './drawing-markup-read-geometry.js';

export interface DrawingMarkupPlacementAnchor {
  /** Model length-unit scale (metres per native unit); see
   *  `SpatialAnchor.lengthUnitScale`. Defaults to 1 (metre file) when
   *  unset, matching `toNativeLength`/`fromNativeLength`. */
  lengthUnitScale?: number;
  /**
   * The re-parsed model store, used to undo the annotation's `ObjectPlacement`
   * chain and the symbolic parser's plan-Y negation — see {@link toAuthoredPoint}.
   * Omitted (a synthetic fixture with no real placement chain, e.g. this
   * module's own unit tests) falls back to treating a parsed point as
   * already-authored, i.e. the identity transform — correct only when the
   * annotation's storey chain IS the identity, which is why those fixtures
   * never caught #4153's real bug.
   */
  store?: IfcDataStore;
  /** Optional per-batch memo, `worldPlacement.ts`'s own `PlacementComposeCache`
   *  — shares one storey chain's composed transform across every markup
   *  annotation under it in one `readDrawingMarkupFromParseResult` call. */
  placementCache?: PlacementComposeCache;
}

/**
 * See the module doc comment above for the derivation. Falls back to the
 * identity (parsed point verbatim) when `anchor.store` is absent or the
 * chain/2x2 can't be composed — the same "can't do better" abstention
 * `composeWorldPlacement` itself documents.
 */
export function toAuthoredPoint(
  expressId: number,
  anchor: DrawingMarkupPlacementAnchor,
  parsed: MarkupPoint2D,
): MarkupPoint2D {
  if (!anchor.store) return { x: parsed.x, y: parsed.y };
  const world = composeWorldPlacement(anchor.store, expressId, anchor.placementCache);
  if (!world) return { x: parsed.x, y: parsed.y };
  const scale = anchor.lengthUnitScale ?? 1;
  const r00 = world[0]!;
  const r01 = world[1]!;
  const tx = world[3]! * scale;
  const r10 = world[4]!;
  const r11 = world[5]!;
  const ty = world[7]! * scale;
  const det = r00 * r11 - r01 * r10;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return { x: parsed.x, y: parsed.y };
  // Undo rebase.rs's plan() negation before solving.
  const worldX = parsed.x;
  const worldY = -parsed.y;
  const dx = worldX - tx;
  const dy = worldY - ty;
  return {
    x: (r11 * dx - r01 * dy) / det,
    y: (r00 * dy - r10 * dx) / det,
  };
}
