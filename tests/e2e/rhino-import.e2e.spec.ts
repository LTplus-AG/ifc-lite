/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real-browser journey for the Rhino `.3dm` import
 * (spec: docs/architecture/rhino-3dm-import.md, "Testing", step 4).
 *
 * The package tests read a `.3dm` in Node and the viewer tests drive the
 * adapter and the tree off real `RhinoImport` data. Neither can answer the one
 * question both left open: does a re-imported `.3dm` land ON the IFC it was
 * exported from, in the viewer's own federated world frame? The spec marks
 * federation alignment [unproven] and names this spec as what proves or
 * refutes it.
 *
 * So this drives the built viewer the way a user does: open the IFC, run
 * `export:3dm` from the command palette, add the downloaded file as a
 * federated model, and compare the two models' per-GlobalId world AABBs. Same
 * place, same size, same up axis — all three fail as a corner gap, and the
 * axis the worst gap sits on says which.
 *
 * The comparison is CPU-side: it reads `geometryResult.meshes` off the
 * production store, so it gates under hosted software WebGPU too. Only the
 * model loads touch the GPU, so they are raced against hosted-GPU device loss
 * like the other viewer specs, and device-loss console lines are not counted
 * as errors under `E2E_GPU_STRICT=0`.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  FOREIGN_3DM, FZK_WALL, IFC_MODEL,
  addModel, entitiesByGlobalId, exportTo3dm, findInHierarchy, hidden, modelSnapshots,
  openViewer, openViewerWithIfc, overlayOf, propertySets, waitForModels,
  type ModelSnapshot,
} from './rhino-import.helpers';

// English labels below: pin the browser language the viewer's Auto locale follows (#9061).
test.use({ locale: 'en-US' });

/** The spec's acceptance tolerance for the overlay: 1 mm. */
const OVERLAY_TOLERANCE_M = 1e-3;
/**
 * The FZK export draws 90 of the model's elements (spec, "Our own exports read
 * back"). Requiring most of them to be matched by GlobalId keeps the overlay
 * from passing on a handful of elements while the rest went missing.
 */
const MIN_MATCHED_ENTITIES = 80;
/**
 * What the IFC draws and the export leaves out by design: an opening is a void
 * rather than a product, and a `*Type` carries the type map's template
 * geometry, which the export emits under its occurrences. These are the only
 * IFC-side GlobalIds the `.3dm` is allowed to be missing.
 */
const NOT_EXPORTED = /^IfcOpeningElement$|Type$/;
/** The reader's own sentence for a file that is not a readable Rhino archive. */
const NOT_A_3DM = 'Not a Rhino .3dm file, or the file is damaged.';

function note(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[rhino-import] ${type}: ${description}`);
}

/** How many of `globalIds` fall under each IFC class, for a readable diagnostic. */
function tally(globalIds: string[], classes: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const globalId of globalIds) {
    const ifcClass = classes[globalId] || '(no class)';
    counts[ifcClass] = (counts[ifcClass] ?? 0) + 1;
  }
  return counts;
}

/** The one model whose load report names `loadPath`; the IFC's is `wasm`. */
function byLoadPath(snapshots: ModelSnapshot[], loadPath: string): ModelSnapshot {
  const found = snapshots.filter((snapshot) => snapshot.loadPath === loadPath);
  expect(found, `one model with loadPath ${loadPath}, saw ${JSON.stringify(snapshots.map((s) => [s.name, s.loadPath]))}`).toHaveLength(1);
  return found[0];
}

test.describe('Rhino .3dm import in the built viewer', () => {
  test.skip(!existsSync(IFC_MODEL), 'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc is missing');

  for (const coordinates of ['local', 'world'] as const) {
    test(`an exported .3dm overlays the IFC it came from (${coordinates} coordinates)`, async ({ page }) => {
      const journey = await openViewerWithIfc(page);
      const bytes = await exportTo3dm(page, coordinates, `ac20-${coordinates}.3dm`);
      note('export-bytes', `${coordinates}: ${bytes.byteLength}`);

      await journey.gpu.raceLoss(`add the ${coordinates} .3dm to the federation`, () =>
        addModel(page, bytes, 'AC20-FZK-Haus.3dm', 2));

      const snapshots = await modelSnapshots(page);
      const ifc = byLoadPath(snapshots, 'wasm');
      const rhino = byLoadPath(snapshots, '3dm');

      // What the store says it is holding (#9976's split): an IFC4 label over
      // a tabular source, loaded through the one `loadFile` path.
      expect(rhino.schemaVersion).toBe('IFC4');
      expect(rhino.sourceKind).toBe('tabular');
      expect(rhino.meshCount).toBeGreaterThan(0);
      expect(rhino.triangles).toBeGreaterThan(0);
      // Containers and drawn objects: the tree's rows are rows of this store
      // too, so the entity count is the drawn entities plus its containers.
      expect(rhino.entityCount).toBeGreaterThan(rhino.boxedEntities);
      note('counts', `ifc: ${ifc.entityCount} entities / ${ifc.meshCount} meshes / ${ifc.triangles} tris / ` +
        `${ifc.boxedEntities} boxed (${ifc.instancedBoxes} instanced-only); ` +
        `3dm: ${rhino.entityCount} entities / ${rhino.meshCount} meshes / ${rhino.triangles} tris / ${rhino.boxedEntities} boxed`);

      // ── The overlay, numerically ──────────────────────────────────────────
      const overlay = overlayOf(ifc, rhino);
      note('overlay', `${coordinates}: ${overlay.matched.length} matched GlobalIds, worst corner gap ` +
        `${overlay.worstGap.toExponential(3)} m at ${JSON.stringify(overlay.worstAt)}, per axis ` +
        `${JSON.stringify(overlay.perAxis)}`);
      note('bounds', `ifc ${JSON.stringify(overlay.firstBounds.map((v) => Number(v.toFixed(4))))} ` +
        `3dm ${JSON.stringify(overlay.secondBounds.map((v) => Number(v.toFixed(4))))}`);
      note('unmatched', `only in the IFC: ${JSON.stringify(tally(overlay.onlyFirst, ifc.classes))}; ` +
        `only in the .3dm: ${JSON.stringify(tally(overlay.onlySecond, rhino.classes))}`);
      expect(overlay.matched.length, `matched GlobalIds (only in the IFC: ${overlay.onlyFirst.length}, only in the .3dm: ${overlay.onlySecond.length})`)
        .toBeGreaterThanOrEqual(MIN_MATCHED_ENTITIES);
      // Nothing the `.3dm` drew is geometry the IFC has not got: an element
      // placed somewhere the IFC never placed it would land here, not in the
      // gap figure below.
      expect(overlay.onlySecond, `the .3dm drew entities the IFC did not: ${JSON.stringify(tally(overlay.onlySecond, rhino.classes))}`).toEqual([]);
      // And the IFC-only ones are only what the export leaves out by design.
      expect(Object.keys(tally(overlay.onlyFirst, ifc.classes)).filter((ifcClass) => !NOT_EXPORTED.test(ifcClass)))
        .toEqual([]);
      // Same place, same size, same up axis: every corner of every matched
      // element, on all three axes, within the tolerance.
      expect(overlay.worstGap, `worst corner gap at ${JSON.stringify(overlay.worstAt)}`).toBeLessThanOrEqual(OVERLAY_TOLERANCE_M);
      // Named per axis as well, so a flipped or swapped up axis reads as such
      // rather than as one large number.
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(overlay.perAxis[axis], `${axis} axis`).toBeLessThanOrEqual(OVERLAY_TOLERANCE_M);
      }

      if (coordinates === 'local') await assertAppState(page, journey, ifc, rhino);
      expect(journey.errors).toEqual([]);
    });
  }

  test('a Rhino-authored file loads with its layer tree and its colours', async ({ page }) => {
    test.skip(!existsSync(FOREIGN_3DM), 'tests/models/rhino/mcneel-rhino3dm/file3dm_stuff.3dm is missing — run pnpm fixtures');
    const journey = await openViewer(page);
    await journey.gpu.raceLoss('open the Rhino-authored sample', async () => {
      await page.locator('#file-input-open').setInputFiles(FOREIGN_3DM);
      await waitForModels(page, 1);
    });

    const [model] = await modelSnapshots(page);
    expect(model.loadPath).toBe('3dm');
    expect(model.schemaVersion).toBe('IFC4');
    note('foreign', `${model.name}: ${model.entityCount} entities, ${model.meshCount} meshes, ${model.triangles} tris, ` +
      `root ${JSON.stringify(model.root)}, children ${JSON.stringify(model.rootChildren)}`);

    // A file with no spatial stamps: the root stands for the file and every
    // layer that holds an object is an `IfcSpatialZone` beneath it (D3).
    expect(model.root?.ifcClass).toBe('IfcProject');
    expect(model.root?.name).toBe('file3dm_stuff.3dm');
    expect(model.rootChildren.length).toBeGreaterThan(0);
    expect(model.rootChildren.every((child) => child.ifcClass === 'IfcSpatialZone')).toBe(true);
    expect(Object.keys(model.storeys), 'a file with no stamps joins no storey list').toEqual([]);

    // The layer rows the panel actually renders, not just the store's tree.
    for (const child of model.rootChildren) {
      await expect(page.locator('[data-hierarchy-node-type="IfcSpatialZone"]').filter({ hasText: child.name }).first()).toBeVisible();
    }

    // Colours come across: Rhino's object and layer colours become the
    // renderer's own `MeshData.color`, so a file with a coloured layer is not
    // uniformly grey.
    const colours = await page.evaluate(() => {
      const model = [...globalThis.__ifc_lite_viewer_store__!.getState().models.values()][0];
      const seen = new Set<string>();
      for (const mesh of model.geometryResult?.meshes ?? []) seen.add(mesh.color.join(','));
      for (const cloud of model.geometryResult?.pointClouds ?? []) {
        const rgb = [...(cloud.chunk.colors ?? []).slice(0, 3)];
        if (rgb.length === 3) seen.add(`cloud:${rgb.join(',')}`);
      }
      return [...seen];
    });
    note('colours', JSON.stringify(colours));
    expect(colours.length).toBeGreaterThan(0);
    // The green Points layer: Rhino's layer colour, not a viewer default.
    expect(colours.some((colour) => /0,0\.498/.test(colour)), JSON.stringify(colours)).toBe(true);

    const shot = test.info().outputPath('rhino-import-layer-tree.png');
    await page.screenshot({ path: shot });
    note('screenshot', shot);
    expect(journey.errors).toEqual([]);
  });

  test('a damaged .3dm and a truncated .3dm are refused, and the viewer stays usable', async ({ page }) => {
    const journey = await openViewerWithIfc(page);
    const errorCard = page.locator('[data-viewport-load-error-card]');
    const whole = await exportTo3dm(page, 'local', 'ac20-for-damage.3dm');

    /** Add `buffer` as `name`, expect the reader's sentence, dismiss it. */
    const refuse = async (name: string, buffer: Buffer, shot?: string) => {
      await page.locator('#file-input-add').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
      await expect(errorCard).toBeVisible();
      await expect(errorCard).toContainText(NOT_A_3DM);
      if (shot) {
        const path = test.info().outputPath(shot);
        await page.screenshot({ path });
        note('screenshot', path);
      }
      await errorCard.getByRole('button', { name: /Dismiss/i }).click();
      await expect(errorCard).toBeHidden();
      // A refusal is not a teardown: the model the viewer had is still there.
      expect((await modelSnapshots(page)).length, `models after refusing ${name}`).toBe(1);
    };

    // A real `.3dm` cut in half: the header passes, the archive does not.
    await refuse('truncated.3dm', whole.subarray(0, Math.floor(whole.byteLength / 2)), 'rhino-import-refusal.png');
    // A file that claims to be a Rhino archive and is not: the 32-byte header
    // is real, everything behind it is zeros. This is the only shape a
    // non-`.3dm` reaches the Rhino reader in, because `detectFormat` reads the
    // first 24 bytes rather than the file's name (see below).
    await refuse('claims-to-be.3dm', Buffer.concat([whole.subarray(0, 32), Buffer.alloc(4096)]));

    // Still usable: the whole file loads straight after the two refusals.
    await journey.gpu.raceLoss('add the intact .3dm after two refusals', () =>
      addModel(page, whole, 'AC20-FZK-Haus.3dm', 2));
    expect(byLoadPath(await modelSnapshots(page), '3dm').meshCount).toBeGreaterThan(0);

    // And the extension decides nothing: an IFC named `.3dm` is read as the IFC
    // it is, not refused as a broken Rhino file. Pinned so a future change to
    // format detection cannot start trusting the name.
    await journey.gpu.raceLoss('add an IFC named .3dm', async () => {
      await page.locator('#file-input-add').setInputFiles({
        name: 'actually-ifc.3dm', mimeType: 'application/octet-stream', buffer: await readFile(IFC_MODEL),
      });
      await waitForModels(page, 3);
    });
    const snapshots = await modelSnapshots(page);
    expect(snapshots.filter((snapshot) => snapshot.loadPath === 'wasm')).toHaveLength(2);
    expect(await errorCard.count()).toBe(0);

    // The two refusals log, by design (`rhinoLoad.ts` rethrows nothing and
    // AGENTS.md forbids a silent catch), and nothing else does.
    const refusals = journey.errors.filter((line) => line.includes('[useIfc] Rhino .3dm reading failed'));
    expect(refusals).toHaveLength(2);
    expect(journey.errors.filter((line) => !refusals.includes(line))).toEqual([]);
  });
});

/**
 * The in-app assertions that do not depend on the coordinate mode: identity,
 * properties, the storey tree, and the hidden state Rhino carried over.
 */
async function assertAppState(
  page: import('@playwright/test').Page,
  journey: { gpu: { raceLoss<T>(stage: string, run: () => Promise<T>): Promise<T> } },
  ifc: ModelSnapshot,
  rhino: ModelSnapshot,
): Promise<void> {
  // ── The storey tree, against the IFC loaded beside it ───────────────────
  note('storeys', `ifc ${JSON.stringify(ifc.storeys)} 3dm ${JSON.stringify(rhino.storeys)}`);
  expect(rhino.storeys, 'the layer stamps rebuild the IFC\'s storeys and their elevations').toEqual(ifc.storeys);
  expect(Object.keys(rhino.storeys).length).toBeGreaterThanOrEqual(2);
  expect(rhino.root?.ifcClass).toBe('IfcProject');
  expect(rhino.root?.globalId, 'the stamped project is the same IFC entity, not a look-alike').toBe(ifc.root?.globalId);

  // ── One element's identity, class and property, through the app ──────────
  const entities = await entitiesByGlobalId(page, rhino.modelId);
  const wall = entities[FZK_WALL.globalId];
  expect(wall, `the FZK wall ${FZK_WALL.globalId} came across`).toBeTruthy();
  expect(wall.ifcClass, 'the class its IFC::Class user text states').toBe(FZK_WALL.ifcClass);
  const sets = await propertySets(page, rhino.modelId, wall.expressId);
  note('wall-psets', `${FZK_WALL.globalId}: ${JSON.stringify(Object.keys(sets))}`);
  // The value the IFC source carries, through Attribute User Text and back.
  expect(sets['Pset_WallCommon']?.['ThermalTransmittance']).toBe('1.5');
  expect(sets['IFC']?.['GlobalId']).toBe(FZK_WALL.globalId);

  // Select it the way the hierarchy and the viewport both do, and read the
  // properties panel the user reads.
  await page.evaluate((id) => {
    globalThis.__ifc_lite_viewer_store__!.getState().setSelectedEntityId(id);
  }, wall.globalExpressId);
  const panel = page.locator('[data-tour="properties-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByText(FZK_WALL.ifcClass, { exact: false }).first()).toBeVisible();
  await expect(panel.getByRole('button', { name: 'ThermalTransmittance: 1.5' })).toBeVisible();
  const properties = test.info().outputPath('rhino-import-properties.png');
  await panel.screenshot({ path: properties });
  note('screenshot', properties);

  // ── The overlay, as a picture ────────────────────────────────────────────
  const overlayShot = test.info().outputPath('rhino-import-overlay.png');
  await page.screenshot({ path: overlayShot });
  note('screenshot', overlayShot);

  // ── Hidden state: the objects on a layer Rhino switched off ──────────────
  // The export puts spaces on their own layers and switches them off, so the
  // import starts them hidden and the tree can show them again. The eye
  // toggle on a spatial container only renders in a single-model session, so
  // drop the IFC first — which is itself an app action, not a store poke.
  const hiddenAtLoad = await hidden(page, rhino.modelId);
  note('hidden-at-load', JSON.stringify(hiddenAtLoad));
  expect(hiddenAtLoad.length, 'Rhino\'s switched-off space layers start hidden').toBeGreaterThan(0);
  expect(hiddenAtLoad.every((entity) => entity.ifcClass === 'IfcSpace'),
    'what the export switched off is exactly its space layers').toBe(true);

  await journey.gpu.raceLoss('drop the IFC and keep the .3dm', async () => {
    await page.evaluate((keep) => {
      const state = globalThis.__ifc_lite_viewer_store__!.getState();
      for (const id of [...state.models.keys()]) if (id !== keep) state.removeModel(id);
    }, rhino.modelId);
    await waitForModels(page, 1);
  });
  expect(await hidden(page, rhino.modelId), 'dropping the other model does not change what Rhino hid').toEqual(hiddenAtLoad);

  // The eye on the row, the way a user shows a layer Rhino had switched off.
  const first = hiddenAtLoad[0].name;
  await findInHierarchy(page, first);
  const show = page.getByRole('button', { name: `Show ${first}`, exact: true });
  await expect(show).toBeVisible();
  await show.click();
  await expect.poll(async () => (await hidden(page, rhino.modelId)).map((entity) => entity.name), { timeout: 10_000 })
    .not.toContain(first);
  note('shown-from-tree', `${first} shown; still hidden: ${JSON.stringify((await hidden(page, rhino.modelId)).map((e) => e.name))}`);
}
