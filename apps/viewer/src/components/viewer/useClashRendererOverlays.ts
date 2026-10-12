/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { anchorWorldLineVertices } from '@/lib/renderer/line-overlay-rte';

/** #6993/#7484: retained focus is CPU-owned; both GPU owners are replaced on
 * recovery even when focused inputs and initialization state stay identical.
 */
export function useClashRendererOverlays(
  rendererRef: RefObject<Pick<Renderer, 'setClashContactLines' | 'setClashOverlapBox' | 'setClashIntersectionSolid'> | null>,
  isInitialized: boolean,
  gpuRecoveryEpoch: number,
): void {
  // Focused-clash indicator (#1277/#1402): prefer the real CONTACT geometry
  // (shared-face polygon outlines / intersection lines) when available, and fall
  // back to the AABB box otherwise. Both draw on the same overlay line buffer, so
  // a single effect drives exactly one of them (no buffer race). Cleared on
  // teardown. On by default; the clash settings toggle hides it.
  const clashOverlapBox = useViewerStore((s) => s.clashOverlapBox);
  const clashContactLines = useViewerStore((s) => s.clashContactLines);
  const showClashRegionBox = useViewerStore((s) => s.showClashRegionBox);
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (showClashRegionBox && clashContactLines && clashContactLines.vertices.length > 0) {
      // No colour: the renderer draws the overlap in its theme's
      // `clashOverlap` and recolours it on a theme switch (#5490).
      renderer.setClashContactLines({ vertices: anchorWorldLineVertices(clashContactLines.vertices) });
    } else if (showClashRegionBox && clashOverlapBox) {
      renderer.setClashOverlapBox(clashOverlapBox);
    } else {
      renderer.setClashContactLines(null);
    }
    // isInitialized: if a clash is focused before the renderer mounts, this effect
    // bails early; depend on it so the indicator is (re)sent once it is ready.
  }, [clashOverlapBox, clashContactLines, showClashRegionBox, isInitialized, gpuRecoveryEpoch]);
  // The focused clash's TRUE intersection volume (BIMcollab Zoom / Solibri
  // style opaque solid), when the kernel resolved one. Independent of the
  // box/lines buffer above — the solid draws through its own pipeline so it
  // can be a real depth-tested 3D volume rather than a line list.
  const clashSolidMesh = useViewerStore((s) => s.clashSolidMesh);
  const clashSolidStatus = useViewerStore((s) => s.clashSolidStatus);
  const clashSelectedId = useViewerStore((s) => s.clashSelectedId);
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    // Defence in depth, not the primary fix (#2574 review): `clashSelectedId`
    // and `clashSolidStatus`/`clashSolidMesh` are reset together by every
    // current teardown path via `setClashSelectedId` / `clearClashSolid` /
    // `clearClash` (clashSlice.ts, all three bump `clashSolidRequestSeq`), so
    // `clashSolidStatus` should never read `'solid'` while nothing is
    // selected. The `!== null` is the real predicate, not truthiness: a clash
    // id is `${ruleId} ${lo} ${hi}` and is never `''`, so the two agree today,
    // but `null` is the value teardown writes and the one worth naming.
    // Gating the actual
    // draw on `clashSelectedId` too means that even a future path that resets
    // one without the other — or a resolved compute that lands after some
    // teardown nobody's added the invalidation to yet — still can't leave an
    // orphaned opaque solid on screen with no clash focused.
    if (clashSelectedId !== null && clashSolidStatus === 'solid' && clashSolidMesh) {
      renderer.setClashIntersectionSolid({
        positions: clashSolidMesh.positions,
        indices: clashSolidMesh.indices,
      });
    } else {
      renderer.setClashIntersectionSolid(null);
    }
  }, [clashSelectedId, clashSolidMesh, clashSolidStatus, isInitialized, gpuRecoveryEpoch]);
}
