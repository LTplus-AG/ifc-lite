/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Keep generated rooms attached by their bounding wall identities, across edits. */
import { polygonPerimeter } from './base-quantities-measure.js';
import { iterateEffectiveEntities } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { generateSpacesFromWalls, buildSpaceBoundaries, GENERATED_SPACE_OBJECTTYPE } from './generate-spaces.js';
import { extractWallSegmentsForStorey } from './extract-walls.js';
import { existingSpaceFootprintEntriesByStorey } from './space-footprints.js';
import { offsetRoomFootprint, polygonArea, pointInPolygon, type BoundaryMode } from './room-footprint-offset.js';
import { roomChainInStore, rewriteRoomOutlineInStore } from './room-store.js';
import { readAttributes } from './edit/placement-core.js';
import { interiorPoint } from './room-candidates.js';

export function prepareGeneratedRoomUpdate(store: IfcDataStore, editor: StoreEditor, storeyIds: readonly number[], notices: string[] = []): () => number[] {
  if (!storeyIds.length) return () => [];
  const report = (message: string) => { notices.push(message); console.warn(`[auto-spaces] ${message}`); };
  const view = editor.getMutationView();
  const hasGenerated = [...iterateEffectiveEntities(store, view, ['IFCSPACE'])]
    .some(({ expressId }) => readAttributes(store, view, editor, expressId)?.[4] === GENERATED_SPACE_OBJECTTYPE);
  if (!hasGenerated) return () => [];
  const spaces = existingSpaceFootprintEntriesByStorey(store, view);
  const detectUncached = (storeyId: number, snapTolerance: number, minArea: number) => {
    const extraction = extractWallSegmentsForStorey(store, storeyId, view);
    const regions = generateSpacesFromWalls(editor, store, storeyId, { dryRun: true, snapTolerance, minArea }, view).detected;
    return regions.map(region => {
      const others = regions.filter(r => r !== region).map(r => r.outline);
      const walls = buildSpaceBoundaries(region.outline, extraction.segments, extraction.contributingWallIds, others)
        .map(b => b.elementId).sort((a, b) => a - b).join(',');
      const outline = (mode: BoundaryMode) => offsetRoomFootprint(region.outline, extraction.segments, extraction.wallThicknesses, mode, others);
      return { region, walls, outline };
    });
  };
  const cache = new Map<string, ReturnType<typeof detectUncached>>();
  const detect = (storeyId: number, snapTolerance: number, minArea: number) => {
    const key = `${storeyId}:${snapTolerance}:${minArea}`;
    let regions = cache.get(key);
    if (!regions) { regions = detectUncached(storeyId, snapTolerance, minArea); cache.set(key, regions); }
    return regions;
  };
  const plans = [...new Set(storeyIds)].flatMap(storeyId => {
    const generated = (spaces.get(storeyId) ?? []).filter(space => readAttributes(store, view, editor, space.expressId)?.[4] === GENERATED_SPACE_OBJECTTYPE);
    if (!generated.length) return [];
    return generated.flatMap(space => {
      const snap = view.getPropertyValue(space.expressId, 'IfcLite_SpaceGeneration', 'SnapTolerance');
      const min = view.getPropertyValue(space.expressId, 'IfcLite_SpaceGeneration', 'MinArea');
      const snapTolerance = typeof snap === 'number' && Number.isFinite(snap) && snap >= 0 ? snap : .1;
      const minArea = typeof min === 'number' && Number.isFinite(min) && min >= 0 ? min : .5;
      const regions = detect(storeyId, snapTolerance, minArea);
      const p = interiorPoint(space.footprint);
      const region = regions.find(r => pointInPolygon(p[0], p[1], r.region.outline));
      if (!region) {
        report(`Generated room #${space.expressId} cannot be re-detected with snap tolerance ${snapTolerance} m; its boundary and quantities will remain unchanged.`);
        return [];
      }
      const mode = (['inner', 'center', 'outer'] as const).reduce((best, m) =>
        Math.abs(polygonArea(region.outline(m)) - polygonArea(space.footprint)) < Math.abs(polygonArea(region.outline(best)) - polygonArea(space.footprint)) ? m : best, 'inner' as BoundaryMode);
      return [{ storeyId, id: space.expressId, walls: region.walls, mode, snapTolerance, minArea }];
    });
  });
  return () => {
    cache.clear(); // Re-read the changed walls once per settings group.
    try {
      // One checkpoint for the room batch, not one whole-graph copy per room.
      // Failure retains every existing room while the enclosing move continues.
      return editor.runAtomic(draft => plans.flatMap(plan => {
        const region = detect(plan.storeyId, plan.snapTolerance, plan.minArea).find(r => r.walls === plan.walls);
        if (!region) { report(`Generated room #${plan.id}: boundary topology changed; retained its outline and quantities.`); return []; }
        const target = roomChainInStore(store, draft, plan.id);
        if (!target.ok) throw new Error(`Cannot update generated room #${plan.id}: ${target.reason}`);
        rewriteRoomOutlineInStore(store, draft, plan.id, target.chain, region.outline(plan.mode), {
          grossArea: region.region.area, netArea: polygonArea(region.outline('inner')),
          grossPerimeter: polygonPerimeter(region.region.outline), netPerimeter: polygonPerimeter(region.outline('inner')),
        });
        return [plan.id];
      }));
    } catch (error) {
      report(`Generated room updates unavailable (${error instanceof Error ? error.message : String(error)}); retained existing outlines and quantities.`);
      return [];
    }
  };
}
