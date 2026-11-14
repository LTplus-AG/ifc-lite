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

import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { readRhino3dm } from '../../packages/rhino3dm/src/index.js';
import {
  FOREIGN_3DM, FZK_WALL, IFC_MODEL, SMALL_IFC,
  STEP_TIMEOUT_MS, addModel, entityByGlobalId, exportTo3dm, hidden, loadPaths, modelCount, modelSnapshots,
  openViewerWith, overlayOf, propertySets, waitForModels,
  type Journey, type ModelSnapshot,
} from './rhino-3dm.helpers';

// English labels below: pin the browser language the viewer's Auto locale follows (#9061).
test.use({ locale: 'en-US' });

/** The spec's acceptance tolerance for the overlay: 1 mm. */
const OVERLAY_TOLERANCE_M = 1e-3;
/**
 * The FZK export draws 90 of the model's elements (spec, "Our own exports read
 * back"). The count is exact, not a floor: the two set assertions below compare
 * the models with each other, so a load that dropped the same elements from
 * both would pass them. This is an element count, so tessellation does not
 * move it.
 */
const FZK_MATCHED_ENTITIES = 90;
/**
 * What the IFC draws and the export leaves out by design: an opening is a void
 * rather than a product, and a `*Type` carries the type map's template
 * geometry, which the export emits under each occurrence instead. IFC's own
 * naming is the test, because the viewer's `isPhysicalObjectType` cannot be
 * imported here: the root tsconfig path-maps `@ifc-lite/*` to `dist/*.d.ts`,
 * so a runtime import of anything that reaches a workspace package resolves to
 * a types-only module and throws at load.
 */
const NOT_EXPORTED = /^IfcOpeningElement$|Type$/;
/** The reader's own sentence (`packages/rhino3dm/src/read/header.ts`, `NOT_3DM_MESSAGE`). */
const NOT_A_3DM = 'Not a Rhino .3dm file, or the file is damaged.';
/** The FZK export's spaces, on the two `IfcSpace` layers it switches off. */
const FZK_HIDDEN_SPACES = 7;
/** Rhino's layer colour for the green Points layer of `file3dm_stuff.3dm`. */
const RHINO_GREEN = [0, 127 / 255, 0];

/**
 * The FZK `.3dm` this file exports once and reuses. Three of the four tests
 * need the same bytes, and the export is the most expensive step in the file.
 */
let fzk3dm: Buffer | undefined;
async function exportedFzk3dm(page: Page): Promise<Buffer> {
  fzk3dm ??= await exportTo3dm(page, 'local', 'ac20-local.3dm');
  return fzk3dm;
}

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

  // The origin FZK cannot distinguish the local and world export frames.
  // #10219's far-origin browser test below proves that distinction.
  for (const coordinates of ['local', 'world'] as const) {
    test(`an exported .3dm overlays the IFC it came from (${coordinates} coordinates)`, async ({ page }) => {
      const journey = await openViewerWith(page, IFC_MODEL, 'open the AC20 house');
      const bytes = coordinates === 'local'
        ? await exportedFzk3dm(page)
        : await exportTo3dm(page, 'world', 'ac20-world.3dm');
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
      expect(rhino.triangles).toBeGreaterThan(0);
      // Containers and drawn objects: the tree's rows are rows of this store
      // too, so the entity count is the drawn entities plus its containers.
      expect(rhino.entityCount).toBeGreaterThan(Object.keys(rhino.boxes).length);
      // FZK's balustrade members go whole to the GPU-instanced shard, so they
      // are absent from `meshes`. Asserting the count keeps the branch that
      // reads `instancedGeometryAabbs` covered: without it the comparison
      // would silently be over the mesh-backed entities alone.
      expect(ifc.instancedBoxes, 'the IFC\'s instanced-only entities are boxed too').toBeGreaterThan(0);
      note('counts', `ifc: ${ifc.entityCount} entities / ${ifc.meshCount} meshes / ${ifc.triangles} tris / ` +
        `${Object.keys(ifc.boxes).length} boxed (${ifc.instancedBoxes} instanced-only); ` +
        `3dm: ${rhino.entityCount} entities / ${rhino.meshCount} meshes / ${rhino.triangles} tris / ` +
        `${Object.keys(rhino.boxes).length} boxed`);

      // ── The overlay, numerically ──────────────────────────────────────────
      const overlay = overlayOf(ifc, rhino);
      note('overlay', `${coordinates}: ${overlay.matched.length} matched GlobalIds, worst corner gap ` +
        `${overlay.worstGap.toExponential(3)} m at ${JSON.stringify(overlay.worstAt)}, per axis ` +
        `${JSON.stringify(overlay.perAxis)}`);
      const extra = tally(overlay.onlySecond, rhino.classes);
      note('unmatched', `only in the IFC: ${JSON.stringify(tally(overlay.onlyFirst, ifc.classes))}; ` +
        `only in the .3dm: ${JSON.stringify(extra)}`);
      expect(overlay.matched.length).toBe(FZK_MATCHED_ENTITIES);
      // Nothing the `.3dm` drew is geometry the IFC has not got: an element
      // placed somewhere the IFC never placed it would land here, not in the
      // gap figure below.
      expect(overlay.onlySecond, `the .3dm drew entities the IFC did not: ${JSON.stringify(extra)}`).toEqual([]);
      // And the IFC-only ids are only what the export leaves out by design.
      const missing = overlay.onlyFirst.filter((globalId) => !NOT_EXPORTED.test(ifc.classes[globalId] ?? ''));
      expect(missing, `the .3dm is missing: ${JSON.stringify(tally(missing, ifc.classes))}`).toEqual([]);
      // Same place, same size, same up axis: every corner of every matched
      // element, on all three axes, within the tolerance. `perAxis` in the note
      // above names which axis a failure sits on.
      expect(overlay.worstGap, `worst corner gap at ${JSON.stringify(overlay.worstAt)}`).toBeLessThanOrEqual(OVERLAY_TOLERANCE_M);

      if (coordinates === 'local') await assertAppState(page, journey, ifc, rhino);
      expect(journey.errors).toEqual([]);
    });
  }

  test('issue #10219: far-origin FZK local and world exports round-trip in the browser', async ({ page }) => {
    const source = await readFile(IFC_MODEL, 'latin1');
    const shifted = source.replace('#115= IFCLOCALPLACEMENT($,#114);',
      '#115= IFCLOCALPLACEMENT($,#9999991);\n#9999991= IFCAXIS2PLACEMENT3D(#9999992,$,$);\n#9999992= IFCCARTESIANPOINT((2600000.,1200000.,400.));');
    expect(shifted, 'the FZK site placement to move (#10219)').not.toBe(source);
    const farIfcPath = test.info().outputPath('AC20-FZK-Haus-far.ifc');
    await writeFile(farIfcPath, Buffer.from(shifted, 'latin1'));

    const journey = await openViewerWith(page, farIfcPath, 'open the far-origin AC20 house');
    const localBytes = await exportTo3dm(page, 'local', 'ac20-far-local.3dm');
    const worldBytes = await exportTo3dm(page, 'world', 'ac20-far-world.3dm');

    // Read the exported document metadata itself: a local file carries the
    // frame restore, while world coordinates already include it.
    const [localDocument, worldDocument] = await Promise.all([
      readRhino3dm(localBytes), readRhino3dm(worldBytes),
    ]);
    expect(localDocument.document.frame).toBe('ifc-world-from-model');
    expect(worldDocument.document.frame).toBe('file');

    await journey.gpu.raceLoss('add both far-origin exports to the federation', async () => {
      await addModel(page, localBytes, 'AC20-FZK-Haus-far-local.3dm', 2);
      await addModel(page, worldBytes, 'AC20-FZK-Haus-far-world.3dm', 3);
    });
    const snapshots = await modelSnapshots(page);
    const ifc = byLoadPath(snapshots, 'wasm');
    const local = snapshots.find((snapshot) => snapshot.name === 'AC20-FZK-Haus-far-local.3dm');
    const world = snapshots.find((snapshot) => snapshot.name === 'AC20-FZK-Haus-far-world.3dm');
    expect(local, 'the re-imported local export').toBeDefined();
    expect(world, 'the re-imported world export').toBeDefined();

    // The boxes below are each in their own model's render frame, so they
    // only say "same place" if the three models share one frame. A `.3dm`
    // left off the IFC's anchor would otherwise still match box for box.
    expect(Math.abs(ifc.drawOffset[0]), 'the far IFC draws from a far anchor').toBeGreaterThan(1e6);
    expect(local!.drawOffset, 'the local .3dm draws in the IFC\'s frame').toEqual(ifc.drawOffset);
    expect(world!.drawOffset, 'the world .3dm draws in the IFC\'s frame').toEqual(ifc.drawOffset);

    for (const [coordinates, overlay] of [
      ['local', overlayOf(ifc, local!)],
      ['world', overlayOf(ifc, world!)],
    ] as const) {
      note('far-origin-overlay', `${coordinates}: ${overlay.matched.length} matched GlobalIds, worst corner gap ` +
        `${overlay.worstGap.toExponential(6)} m at ${JSON.stringify(overlay.worstAt)}, per axis ${JSON.stringify(overlay.perAxis)}`);
      expect(overlay.matched, `${coordinates}: exactly the FZK's 90 matched GlobalIds`).toHaveLength(FZK_MATCHED_ENTITIES);
      expect(overlay.onlySecond, `${coordinates}: no geometry outside the IFC`).toEqual([]);
      const missing = overlay.onlyFirst.filter((globalId) => !NOT_EXPORTED.test(ifc.classes[globalId] ?? ''));
      expect(missing, `${coordinates}: no unexpected IFC entities missing`).toEqual([]);
      expect(overlay.worstGap, `${coordinates}: worst corner gap at ${JSON.stringify(overlay.worstAt)}`)
        .toBeLessThanOrEqual(OVERLAY_TOLERANCE_M);
    }
    expect(journey.errors).toEqual([]);
  });

  test('a Rhino-authored file loads with its layer tree and its colours', async ({ page }) => {
    test.skip(!existsSync(FOREIGN_3DM), 'tests/models/rhino/mcneel-rhino3dm/file3dm_stuff.3dm is missing — run pnpm fixtures');
    const journey = await openViewerWith(page, FOREIGN_3DM, 'open the Rhino-authored sample');

    const [model] = await modelSnapshots(page);
    expect(model.loadPath).toBe('3dm');
    expect(model.schemaVersion).toBe('IFC4');
    note('foreign', `${model.name}: ${model.entityCount} entities, ${model.meshCount} meshes, ${model.triangles} tris, ` +
      `root ${JSON.stringify(model.root)}, children ${JSON.stringify(model.rootChildren)}`);

    // A file with no spatial stamps: the root stands for the file and every
    // layer that holds an object is an `IfcSpatialZone` beneath it (D3).
    expect(model.root?.ifcClass).toBe('IfcProject');
    expect(model.root?.name).toBe(basename(FOREIGN_3DM));
    expect(model.rootChildren.length).toBeGreaterThan(0);
    expect(model.rootChildren.every((child) => child.ifcClass === 'IfcSpatialZone')).toBe(true);
    expect(Object.keys(model.storeys), 'a file with no stamps joins no storey list').toEqual([]);

    // The layer rows the panel actually renders, not just the store's tree.
    for (const child of model.rootChildren) {
      await expect(page.locator('[data-hierarchy-node-type="IfcSpatialZone"]').filter({ hasText: child.name }).first()).toBeVisible();
    }

    // Rhino's layer colour reaches the renderer's own `MeshData.color`, on the
    // mesh and on the point cloud alike, rather than a viewer default.
    note('colours', JSON.stringify(model.colours));
    const green = model.colours.filter((colour) =>
      RHINO_GREEN.every((channel, axis) => Math.abs(colour[axis] - channel) < 1e-6));
    expect(green, `the green Points layer, among ${JSON.stringify(model.colours)}`).toHaveLength(2);

    const shot = test.info().outputPath('rhino-import-layer-tree.png');
    await page.screenshot({ path: shot });
    note('screenshot', shot);
    expect(journey.errors).toEqual([]);
  });

  test('a damaged .3dm and a truncated .3dm are refused, and the viewer stays usable', async ({ page }) => {
    const journey = await openViewerWith(page, IFC_MODEL, 'open the AC20 house');
    const errorCard = page.locator('[data-viewport-load-error-card]');
    const whole = await exportedFzk3dm(page);

    /** Add `buffer` as `name`, expect the reader's sentence, dismiss it. */
    const refuse = async (name: string, buffer: Buffer, shot?: string) => {
      await page.locator('#file-input-add').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
      // The refusal comes from the reader's worker, which has to start and
      // parse first: over the 5 s default on a loaded CI runner.
      await expect(errorCard).toBeVisible({ timeout: STEP_TIMEOUT_MS });
      await expect(errorCard).toContainText(NOT_A_3DM);
      if (shot) {
        const path = test.info().outputPath(shot);
        await page.screenshot({ path });
        note('screenshot', path);
      }
      await errorCard.getByRole('button', { name: /Dismiss/i }).click();
      await expect(errorCard).toBeHidden();
      // A refusal is not a teardown: the model the viewer had is still there.
      expect(await modelCount(page), `models after refusing ${name}`).toBe(1);
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
    expect(await loadPaths(page), 'the .3dm loaded, with the geometry `waitForModels` gated on').toEqual(['wasm', '3dm']);

    // And the extension decides nothing: an IFC named `.3dm` is read as the IFC
    // it is, not refused as a broken Rhino file. Pinned so a future change to
    // format detection cannot start trusting the name.
    await journey.gpu.raceLoss('add an IFC named .3dm', async () => {
      await page.locator('#file-input-add').setInputFiles({ name: 'actually-ifc.3dm', mimeType: 'application/octet-stream', buffer: await readFile(SMALL_IFC) });
      await waitForModels(page, 3);
    });
    expect((await loadPaths(page)).filter((loadPath) => loadPath === 'wasm')).toHaveLength(2);
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
async function assertAppState(page: Page, journey: Journey, ifc: ModelSnapshot, rhino: ModelSnapshot): Promise<void> {
  // ── The storey tree, against the IFC loaded beside it ───────────────────
  note('storeys', `ifc ${JSON.stringify(ifc.storeys)} 3dm ${JSON.stringify(rhino.storeys)}`);
  expect(rhino.storeys, 'the layer stamps rebuild the IFC\'s storeys and their elevations').toEqual(ifc.storeys);
  expect(Object.keys(rhino.storeys).length).toBeGreaterThanOrEqual(2);
  expect(rhino.root?.ifcClass).toBe('IfcProject');
  expect(rhino.root?.globalId, 'the stamped project is the same IFC entity, not a look-alike').toBe(ifc.root?.globalId);

  // ── One element's identity, class and property, through the app ──────────
  const wall = await entityByGlobalId(page, rhino.modelId, FZK_WALL.globalId);
  expect(wall, `the FZK wall ${FZK_WALL.globalId} came across`).toBeTruthy();
  expect(wall!.ifcClass, 'the class its IFC::Class user text states').toBe(FZK_WALL.ifcClass);
  const sets = await propertySets(page, rhino.modelId, wall!.expressId);
  note('wall-psets', `${FZK_WALL.globalId}: ${JSON.stringify(Object.keys(sets))}`);
  // The value the IFC source carries, through Attribute User Text and back.
  expect(sets['Pset_WallCommon']?.['ThermalTransmittance']).toBe('1.5');
  expect(sets['IFC']?.['GlobalId']).toBe(FZK_WALL.globalId);

  // Select it the way the hierarchy and the viewport both do, and read the
  // properties panel the user reads.
  await selectEntity(page, wall!.globalExpressId);
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
  // The export puts spaces on their own layers and switches those off, so the
  // import starts them hidden and the tree can show them again.
  const hiddenAtLoad = await hidden(page, rhino.modelId);
  note('hidden-at-load', JSON.stringify(hiddenAtLoad));
  // The FZK export puts its seven spaces on two switched-off layers, which is
  // the number the import contract states; a regression to six would otherwise
  // pass a `> 0` floor.
  expect(hiddenAtLoad).toHaveLength(FZK_HIDDEN_SPACES);
  expect(hiddenAtLoad.every((entity) => entity.ifcClass === 'IfcSpace'),
    `what the export switched off is exactly its space layers: ${JSON.stringify(hiddenAtLoad)}`).toBe(true);

  // Showing one again from the tree needs a single-model session: in a
  // federation the panel's spatial tab lists unified storeys and model rows,
  // and the space's own row is not reachable from it. `removeModel` is a store
  // call, as in `command-palette-access` and `copc-lod`; the app's own path is
  // the model row's Remove model and its confirm dialog. That the eye is out
  // of reach while a second model is loaded is a product gap, not something
  // this test can assert around.
  await journey.gpu.raceLoss('drop the IFC and keep the .3dm', async () => {
    await page.evaluate((keep) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      for (const id of [...state.models.keys()]) if (id !== keep) state.removeModel(id);
    }, rhino.modelId);
    await waitForModels(page, 1);
  });
  expect(await hidden(page, rhino.modelId), 'dropping the other model does not change what Rhino hid').toEqual(hiddenAtLoad);

  // Selecting the space reveals its row: `useRevealSelection` expands the
  // ancestors for a selection made outside the tree, which is the seam the
  // viewport, search and BCF all reach a row through.
  const space = hiddenAtLoad[0];
  await selectEntity(page, space.globalExpressId);
  const show = page.getByRole('button', { name: `Show ${space.name}`, exact: true });
  await expect(show).toBeVisible();
  await show.click();
  let stillHidden: string[] = [];
  await expect.poll(async () => (stillHidden = (await hidden(page, rhino.modelId)).map((entity) => entity.name)), { timeout: 10_000 })
    .not.toContain(space.name);
  note('shown-from-tree', `${space.name} shown; still hidden: ${JSON.stringify(stillHidden)}`);
}

/** Select by the federated id the viewport and the hierarchy both select by. */
async function selectEntity(page: Page, globalExpressId: number): Promise<void> {
  await page.evaluate((id) => {
    globalThis.__ifc_lite_viewer_store__.getState().setSelectedEntityId(id);
  }, globalExpressId);
}
