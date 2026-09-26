/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical, format-neutral federation acceptance for the CC0 bonsai-topo
 * control triplet (#5051). The IFC, LandXML and XYZ files are independently
 * authored representations of five asymmetric survey controls. This test
 * intentionally drives the viewer's Open/Add file controls: Open reaches
 * useIfcLoader.loadFile and each Add reaches useIfcFederation.addModel, its
 * deliberately thin wrapper around that same loadFile route.
 *
 * The control file declares local engineering coordinates and independently
 * authored projected coordinates. The test normalizes only the renderer's
 * documented Y-up frame back to that local engineering frame; it does not
 * reconstruct MapConversion, CRS, RTC, or point-cloud alignment matrices.
 * Thus a second ingest route or an ad-hoc test transform cannot make this
 * pass.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import type { ViewerState } from '../../apps/viewer/src/store';
import {
  assertCanonicalCorrespondences,
  assertFederatedResolution,
  assertIndependentControls,
  assertSingleModelResolution,
  canonicalToRender,
  controlFile,
  distance,
  loadControlTriplet,
  renderToCanonical,
  snapshotModels,
  waitForModels,
  type ControlFile,
  type ModelSnapshot,
  type Point3,
} from './federation-control-triplet.helpers';
import { assertIsolatedRenderedContent, ordinaryGpuSelectControl, snapshotRenderedPointCloud } from './federation-control-triplet.rendering';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

const CONTROL_DIR = 'tests/models/landxml/federation/bonsai-topo-control-v1';
const CONTROL = `${CONTROL_DIR}/control.json`;
const IFC = `${CONTROL_DIR}/terrain.ifc`;
const LANDXML = `${CONTROL_DIR}/terrain.xml`;
const XYZ = `${CONTROL_DIR}/survey.xyz`;
const FIXTURES = [CONTROL, IFC, LANDXML, XYZ] as const;
const LOAD_TIMEOUT_MS = 120_000;
const GPU_STRICT = process.env.E2E_GPU_STRICT !== '0';

interface PlacementSnapshot {
  modelId: string;
  translation: Point3;
  rotation: { angle: number; pivot: Point3 };
  locked: boolean;
}

interface PickedControl {
  source: { modelId: string; point: Point3 } | null;
  target: { modelId: string; point: Point3 } | null;
  delta: Point3;
  modelIds: readonly string[];
  before: PlacementSnapshot[];
  placements: PlacementSnapshot[];
}

/**
 * The Placement panel's "Reference model" is a Radix Select since #5974, not a
 * native <select>: open its trigger, then pick the model's option (listed by
 * name, rendered in a portal outside the panel).
 */
async function chooseReferenceModel(page: Page, panel: Locator, reference: ModelSnapshot): Promise<void> {
  await panel.getByLabel('Reference model', { exact: true }).click();
  await page.getByRole('option', { name: reference.name, exact: true }).click();
  await expect(panel.getByLabel('Reference model', { exact: true })).toContainText(reference.name);
}

async function openRepositionPanelForModel(
  page: Page, moving: ModelSnapshot, models: readonly ModelSnapshot[],
): Promise<Locator> {
  await page.getByRole('button', { name: 'Reposition models and pointclouds', exact: true }).click();
  const panel = page.locator('section[aria-label="Reposition models"]');
  await expect(panel, 'the visible Reposition workflow opens').toBeVisible();
  const movingCheckbox = panel.getByLabel(moving.name, { exact: true });
  // Select the desired mover before unchecking the default active model: the
  // panel quite rightly refuses an empty moving-model set.
  if (!(await movingCheckbox.isChecked())) await movingCheckbox.click();
  for (const model of models) {
    if (model.id === moving.id) continue;
    const checkbox = panel.getByLabel(model.name, { exact: true });
    if (await checkbox.isChecked()) await checkbox.click();
  }
  await expect(movingCheckbox, `${moving.name} is the only moving model`).toBeChecked();
  for (const model of models) {
    if (model.id !== moving.id) {
      await expect(panel.getByLabel(model.name, { exact: true }), `${model.name} remains fixed`).not.toBeChecked();
    }
  }
  return panel;
}

interface ManualPlacement {
  controlId: string;
  correction: Point3;
  preview: Point3;
  committed: PlacementSnapshot;
}

async function placeUnknownCrsXyzThroughPanel(
  page: Page, control: ControlFile['points'][number], xyz: ModelSnapshot, reference: ModelSnapshot,
  models: readonly ModelSnapshot[],
): Promise<ManualPlacement> {
  const panel = await openRepositionPanelForModel(page, xyz, models);
  await chooseReferenceModel(page, panel, reference);

  // CP1 is a single independently authored survey control. The user enters
  // only its stated local-minus-projected correction; the other four controls
  // remain independent acceptance evidence below.
  const correction: Point3 = [
    control.local[0] - control.projected[0],
    control.local[1] - control.projected[1],
    control.local[2] - control.projected[2],
  ];
  for (const [index, axis] of ['X', 'Y', 'Z'].entries()) {
    await panel.getByLabel(`Delta ${axis}`, { exact: true }).fill(`${correction[index]} m`);
  }
  await panel.getByRole('button', { name: 'Preview values', exact: true }).click();
  const preview = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().modelPlacement.preview?.delta);
  expect(preview, 'visible numeric values drive the production preview').toEqual(correction);
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  const committed = await page.evaluate((modelId) => {
    const placement = globalThis.__ifc_lite_viewer_store__.getState().modelPlacement.placements.get(modelId);
    if (!placement) throw new Error('Reposition Apply did not commit the selected point cloud');
    return { modelId, ...placement };
  }, xyz.id);
  expect(committed.translation, 'visible Apply commits the CP1 correction').toEqual(correction);
  await panel.getByRole('button', { name: 'Cancel repositioning', exact: true }).click();
  return { controlId: control.id, correction, preview: preview!, committed };
}

async function projectUnobscuredControl(page: Page, control: { id: string; local: Point3 }): Promise<{ x: number; y: number }> {
  // Sparse survey controls can fall under the persistent point-cloud palette
  // or Reposition card in one view. Cycle real ViewCube commands until the
  // same on-canvas control is accessible; no synthetic pointer transform or
  // hidden camera mutation is used.
  for (const view of [null, 'TOP', 'FRONT', 'BACK', 'RIGHT', 'LEFT'] as const) {
    if (view) {
      // Faces overlap as the ViewCube animates between orientations; dispatch
      // the named, visible control rather than waiting for another face to
      // vacate its hitbox.
      await page.getByRole('button', { name: view, exact: true }).click({ force: true });
      await page.waitForTimeout(500);
    }
    const projected = await page.evaluate((point) => globalThis.__ifc_lite_viewer_store__.getState()
      .cameraCallbacks.projectToScreen!(point), canonicalToRender(control.local));
    if (!projected) continue;
    const canvas = await page.locator('canvas').first().boundingBox();
    if (!canvas) continue;
    // A magnetic pick needs a small in-canvas aperture around the visual
    // control. A centre pixel beside the Reposition card is not enough: its
    // adjacent snap candidate could be swallowed by the card rather than the
    // canvas pointer handler.
    const onCanvas = await page.evaluate(({ x, y }) => [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4], [6, 6], [-6, -6]]
      .every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy)?.closest('canvas') !== null), {
      x: canvas.x + projected.x,
      y: canvas.y + projected.y,
    });
    if (onCanvas) return projected;
  }
  throw new Error(`${control.id}: no ViewCube orientation exposes the control on the viewport canvas`);
}

async function clickVisibleControl(
  page: Page, canvas: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>,
  projected: { x: number; y: number }, accepts: () => Promise<boolean>, controlId: string, role: 'source' | 'target',
): Promise<{ x: number; y: number }> {
  // The visual splat and point-cloud ray index use independent pixel rounding.
  // Click within the same visible snap aperture until the real Reposition
  // panel accepts the constrained source/target role. A rejected click leaves
  // picking active, so this is precisely the user-facing recovery path.
  for (const [dx, dy] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4], [6, 6], [-6, -6]]) {
    const candidate = { x: canvas.x + projected.x + dx, y: canvas.y + projected.y + dy };
    await page.mouse.click(candidate.x, candidate.y);
    await page.waitForTimeout(75);
    if (await accepts()) return candidate;
  }
  throw new Error(`${controlId}: Reposition did not accept an eligible ${role} point within the visible snap aperture`);
}

async function pickControlThroughRenderer(
  page: Page, control: { id: string; local: Point3 }, moving: ModelSnapshot, reference: ModelSnapshot,
  models: readonly ModelSnapshot[],
): Promise<PickedControl> {
  const panel = await openRepositionPanelForModel(page, moving, models);
  await chooseReferenceModel(page, panel, reference);
  await panel.getByRole('button', { name: 'Frame both', exact: true }).click();
  await page.waitForTimeout(500); // Frame both uses the viewport's animated camera fit.
  const projected = await projectUnobscuredControl(page, control);
  const canvas = await page.locator('canvas').first().boundingBox();
  expect(canvas, 'viewer canvas').not.toBeNull();
  await panel.getByRole('button', { name: 'Pick source point', exact: true }).click();
  await expect.poll(() => page.locator('canvas').evaluate((element) => element.style.cursor)).toBe('crosshair');
  const targetButton = panel.getByRole('button', { name: 'Pick target point', exact: true });
  await clickVisibleControl(page, canvas!, projected!, () => targetButton.isEnabled(), control.id, 'source');
  await expect(targetButton, `${control.id}: source role accepts the constrained visible hover`).toBeEnabled();
  await targetButton.click();
  await page.waitForTimeout(300); // allow the source-pick effect to hand off to target-pick mode
  await clickVisibleControl(page, canvas!, projected!, () => page.evaluate((referenceId) =>
    globalThis.__ifc_lite_viewer_store__.getState().modelPlacement.preview?.target?.modelId === referenceId,
  reference.id), control.id, 'target');
  const picked = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const preview = state.modelPlacement.preview;
    return {
      source: preview?.source ?? null,
      target: preview?.target ?? null,
      delta: preview?.delta ?? [0, 0, 0],
      modelIds: preview?.modelIds ?? [],
      before: [...(preview?.before ?? new Map()).entries()].map(([modelId, placement]) => ({ modelId, ...placement })),
      placements: [...state.models.keys()].map((modelId) => ({ modelId, ...(state.modelPlacement.placements.get(modelId)
        ?? { translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }) })),
    };
  });
  return picked as PickedControl;
}

function assertPickedControl(
  control: { id: string; local: Point3 }, picked: PickedControl, movingModelId: string, referenceModelId: string,
  tolerance: number, expectedMovingTranslation: Point3 = [0, 0, 0],
  expectedExistingTranslations: ReadonlyMap<string, Point3> = new Map(),
): void {
  expect(picked.modelIds).toEqual([movingModelId]);
  expect(picked.before).toEqual([{
    modelId: movingModelId, translation: expectedMovingTranslation, rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false,
  }]);
  expect(picked.source, `${control.id}: moving source is picked from its requested model`).not.toBeNull();
  expect(picked.target, `${control.id}: fixed target is picked from its requested model`).not.toBeNull();
  expect(picked.source!.modelId).toBe(movingModelId);
  expect(picked.target!.modelId).toBe(referenceModelId);
  expect(distance(picked.source!.point, control.local), `${control.id}: source canonical point`).toBeLessThanOrEqual(tolerance);
  expect(distance(picked.target!.point, control.local), `${control.id}: target canonical point`).toBeLessThanOrEqual(tolerance);
  expect(Math.hypot(...picked.delta), `${control.id}: aligned pair has no preview compensation`).toBeLessThanOrEqual(tolerance);
  for (const placement of picked.placements) {
    expect(placement, `${control.id}: preview leaves committed ${placement.modelId} placement unchanged`).toEqual({
      modelId: placement.modelId,
      translation: placement.modelId === movingModelId
        ? expectedMovingTranslation
        : expectedExistingTranslations.get(placement.modelId) ?? [0, 0, 0],
      rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false,
    });
  }
}

test('canonical IFC + LandXML + XYZ federation keeps five independent bonsai-topo controls within tolerance (#5051)', async ({ page }, testInfo) => {
  const absent = FIXTURES.filter((fixture) => !existsSync(fixture));
  test.skip(absent.length > 0, `${absent.join(', ')} missing — run \`pnpm fixtures\``);
  const controls = controlFile(CONTROL);
  expect(controls.toleranceMetres, 'the control declaration remains a 1 mm acceptance').toBe(0.001);
  assertIndependentControls(controls);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const primary = await loadControlTriplet(page, testInfo, {
    ifc: IFC, landxml: LANDXML, xyz: XYZ, timeout: LOAD_TIMEOUT_MS, strictGpu: GPU_STRICT,
  }, pageErrors);
  if (!primary) {
    test.skip(true, `E2E_GPU_STRICT=0: software WebGPU failed before model load; evidence attached.`);
    return;
  }
  const models = await snapshotModels(page);
  expect(models).toHaveLength(3);
  const ifc = models.find((model) => model.name === 'terrain.ifc');
  const landxml = models.find((model) => model.name === 'terrain.xml');
  const xyz = models.find((model) => model.name === 'survey.xyz');
  expect(ifc, 'IFC model registered from the primary load').toBeDefined();
  expect(landxml, 'LandXML model registered from the same federated load path').toBeDefined();
  expect(xyz, 'XYZ model registered from the same federated load path').toBeDefined();

  expect(ifc!.loadPath).toBe('wasm');
  expect(landxml!.loadPath).toBe('landxml');
  expect(xyz!.loadPath).toBe('point-cloud');
  // Open creates the primary model before federation exists, so it has no
  // explicit alignment badge. It is nevertheless the effective anchor used
  // by both subsequent Add operations (the LandXML status below proves the
  // second model entered that frame). Requiring the UI-only `anchor` marker
  // here would misstate the canonical primary-load contract.
  expect(ifc!.alignment).toBeUndefined();
  expect(landxml!.alignment).toBe('same-crs');
  // XYZ has no CRS metadata. Automatic federation therefore must refuse to
  // guess a map conversion: it stays in its authored projected coordinates
  // until a user supplies a surveyed control through Reposition below.
  expect(xyz!.alignment, 'unknown-CRS XYZ is explicitly not auto-aligned').toBe('none');
  expect(xyz!.pointCloudHandleId, 'XYZ reached the streamed point-cloud renderer').toBeDefined();
  expect(models.every((model) => model.visible), 'every control source is visibly enabled').toBe(true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pointCloudAssetCount),
    'the renderer reports the XYZ streamed asset as ready').toBeGreaterThanOrEqual(1);
  await assertFederatedResolution(page, models);

  // The product has already performed CRS/MapConversion/RTC alignment. Only
  // undo its documented Y-up render frame before comparing independent control
  // coordinates; this test contains no fixture-local origin or CRS transform.
  expect(ifc!.vertices).toHaveLength(controls.points.length);
  expect(landxml!.vertices).toHaveLength(controls.points.length);
  assertCanonicalCorrespondences(controls, 'IFC', ifc!.vertices.map(renderToCanonical));
  assertCanonicalCorrespondences(controls, 'LandXML', landxml!.vertices.map(renderToCanonical));

  // Streamed XYZ positions are deliberately absent from GeometryResult. The
  // viewport hook reads the retained production sample through the live point
  // renderer matrix. Before a user places it, that matrix truthfully retains
  // the projected source coordinates rather than silently guessing a CRS.
  const rawXyz = await snapshotRenderedPointCloud(page, xyz!.pointCloudHandleId!, LOAD_TIMEOUT_MS);
  expect(rawXyz.pointCount, 'XYZ stream contains all five declared controls').toBe(controls.points.length);
  expect(rawXyz.points, 'XYZ renderer sample contains all five declared controls').toHaveLength(controls.points.length);
  assertCanonicalCorrespondences(controls, 'unplaced XYZ renderer', rawXyz.points.map(renderToCanonical), (control) => control.projected);
  expect(distance(renderToCanonical(rawXyz.points[0]!), controls.points[0]!.local),
    'refused automatic alignment leaves CP1 at its projected, not local, coordinates').toBeGreaterThan(1_000_000);
  expect(await page.evaluate((modelId) => globalThis.__ifc_lite_viewer_store__.getState().modelPlacement.placements.has(modelId), xyz!.id),
    'automatic federation creates no hidden XYZ placement').toBe(false);

  const manualPlacement = await placeUnknownCrsXyzThroughPanel(page, controls.points[0]!, xyz!, ifc!, models);
  const renderedXyz = await snapshotRenderedPointCloud(page, xyz!.pointCloudHandleId!, LOAD_TIMEOUT_MS);
  assertCanonicalCorrespondences(controls, 'XYZ renderer after the user placement', renderedXyz.points.map(renderToCanonical));
  // The tiny control scan is intentionally only five points. Increase the
  // visible point-size through its real viewport control before asking PNG
  // density to distinguish that isolated scan from an empty canvas. Those
  // controls live in the Point Clouds side panel (#5507), and Reposition just
  // docked the Placement panel in its place (#5505): bring it back the way a
  // user would, from the activity bar.
  const pointCloudsPanel = page.getByRole('button', { name: 'Point Clouds', exact: true });
  if ((await pointCloudsPanel.getAttribute('aria-pressed')) !== 'true') await pointCloudsPanel.click();
  await page.locator('input[type="range"]').first().fill('20');
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pointCloudPointSize)).toBe(20);
  // Edge shading intentionally amplifies continuous scan depth. Disable it through
  // its viewport control for this five-point survey target so it cannot turn
  // each isolated splat into an edge-only post-process sample.
  await page.getByRole('checkbox', { name: 'Edge shading', exact: true }).uncheck();
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pointCloudEdlEnabled)).toBe(false);

  // Hide the overlapping sources one at a time and assert that each one
  // actually paints. The PNG density is an assertion, not a screenshot-only
  // attachment, and Frame moving is the normal production model framing path.
  const renderedContent = [
    await assertIsolatedRenderedContent(page, ifc!.id, GPU_STRICT),
    await assertIsolatedRenderedContent(page, landxml!.id, GPU_STRICT),
    await assertIsolatedRenderedContent(page, xyz!.id, GPU_STRICT),
  ];

  // In addition to magnetic placement picks below, prove normal viewport
  // clicks reach the ordinary GPU pick/selection channel while model isolation
  // removes the ambiguity of three coincident control representations.
  const ordinarySelections = {
    ifc: await ordinaryGpuSelectControl(page, ifc!.id, controls.points[3]!, canonicalToRender, GPU_STRICT),
    xyz: await ordinaryGpuSelectControl(page, xyz!.id, controls.points[3]!, canonicalToRender, GPU_STRICT),
  };
  if (GPU_STRICT) {
    expect(ordinarySelections.ifc.selectedEntityId, 'ordinary IFC GPU pick supplies a renderer highlight id').not.toBeNull();
    expect(ordinarySelections.ifc.selectedEntity?.modelId, 'ordinary IFC GPU pick retains federation owner').toBe(ifc!.id);
    expect(ordinarySelections.xyz.selectedEntityId, 'ordinary XYZ GPU pick supplies the synthetic renderer id').not.toBeNull();
    expect(ordinarySelections.xyz.selectedEntity?.modelId, 'ordinary XYZ GPU pick retains federation owner').toBe(xyz!.id);
  }

  // Restore the federated visual state before model-to-model placement picks.
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.clearEntitySelection();
    state.setIsolatedEntities(null);
    state.setModelsVisibility([...state.models.keys()], true);
  });
  await waitForModels(page, 3, LOAD_TIMEOUT_MS);

  // These are real magnetic picks, constrained by the production Reposition
  // panel to the named moving/reference models. Every XYZ control must be
  // independently picked against LandXML; the source model constraint prevents
  // a coincident IFC vertex from making the scan path pass by accident.
  const commonTinFace = { id: 'IFC/LandXML TIN face 1-2-5', local: [10, 10 / 3, 5 / 6] as Point3 };
  let ifcToLandxml: PickedControl | null = null;
  const xyzToLandxml: Record<string, PickedControl> = {};
  if (GPU_STRICT) {
    ifcToLandxml = await pickControlThroughRenderer(page, commonTinFace, ifc!, landxml!, models);
    assertPickedControl(commonTinFace, ifcToLandxml, ifc!.id, landxml!.id, controls.toleranceMetres,
      [0, 0, 0], new Map([[xyz!.id, manualPlacement.correction]]));
    await page.keyboard.press('Escape');
    for (const control of controls.points) {
      const picked = await pickControlThroughRenderer(page, control, xyz!, landxml!, models);
      assertPickedControl(control, picked, xyz!.id, landxml!.id, controls.toleranceMetres, manualPlacement.correction);
      xyzToLandxml[control.id] = picked;
      await page.keyboard.press('Escape');
    }
  } else {
    testInfo.annotations.push({
      type: 'gpu-skip',
      description: 'E2E_GPU_STRICT=0: renderer-dependent Reposition picks require the strict hardware witness',
    });
    console.log('[e2e] E2E_GPU_STRICT=0 — skipping renderer-dependent Reposition picks (software WebGPU)');
  }
  await page.keyboard.press('Escape');
  const placementState = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return {
      preview: state.modelPlacement.preview,
      placements: [...state.models.keys()].map((modelId) => ({ modelId, ...(state.modelPlacement.placements.get(modelId)
        ?? { translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }) })),
    };
  });
  expect(placementState.preview, 'closing the panel clears preview placement state').toBeNull();
  for (const placement of placementState.placements) {
    expect(placement, `only the visible XYZ Reposition workflow compensates ${placement.modelId}`).toEqual({
      modelId: placement.modelId, translation: placement.modelId === xyz!.id ? manualPlacement.correction : [0, 0, 0],
      rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false,
    });
  }
  await testInfo.attach('bonsai-topo-control-correspondence', {
    body: JSON.stringify({ toleranceMetres: controls.toleranceMetres, controls: controls.points,
      rawXyz, renderedXyz, manualPlacement, renderedContent, ordinarySelections,
      previews: { ifcToLandxml, xyzToLandxml }, placementState }),
    contentType: 'application/json',
  });
});
