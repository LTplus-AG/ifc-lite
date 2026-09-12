/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { faceMaskProductSource } from '@/test/face-mask-fixture.js';
import { faceMaskRequests, normalizeFaceTriangles, reconcileFaceMasks, type FaceMask, type FaceMasks } from './face-masks.js';
import type { AppearancePlan, AppearanceRequest } from './planner-types.js';

const label = (id: number) => `IFC object #${id}`;
const mask = (productId: number, triangles: number[], fingerprint = 'a'.repeat(64)): FaceMask =>
  ({ productId, surfaceFingerprint: fingerprint, triangles: Uint32Array.from(triangles) });
const plan = (partial: Partial<AppearancePlan>): AppearancePlan => ({ sourceRevision: 'r', nextExpressId: 100, nextAvailableExpressId: 100,
  created: [], edits: [], removed: [], exclusions: [], items: [], ...partial });

test('face mask requests carry only in-scope, non-empty selections in ascending order (#4404)', () => {
  const masks: FaceMasks = new Map([[25, mask(25, [3, 0, 1])], [35, mask(35, [2])], [45, { ...mask(45, []) }]]);
  assert.deepEqual(faceMaskRequests(masks, [25, 45, 99]), [{ productId: 25, surfaceFingerprint: 'a'.repeat(64), triangles: [3, 0, 1] }]);
  assert.equal(faceMaskRequests(masks, [99]), undefined, 'no in-scope mask leaves the request without the field');
  assert.deepEqual([...normalizeFaceTriangles([3, 0, 3, 1, -1, 12, 2.5], 4)], [0, 1, 3]);
});

test('reconciliation drops a mask the planner reports stale or direct-bodied and keeps the map identity otherwise (#4404)', () => {
  const masks: FaceMasks = new Map([[25, mask(25, [0])], [35, mask(35, [1])], [45, mask(45, [0, 1])]]);
  const unchanged = reconcileFaceMasks(masks, plan({ exclusions: [{ productId: 99, reason: 'Face selection is stale: the evaluated surface geometry changed' }],
    conversions: [{ productId: 25, representationId: 1, sourceGeometryItemId: 2, geometryItemId: 3, sourceIndices: [0, 1, 2], surfaceFingerprint: 'a'.repeat(64) }] }), label);
  assert.equal(unchanged.masks, masks, 'nothing to drop returns the same map instance');
  assert.deepEqual(unchanged.diagnostics, []);
  const stale = reconcileFaceMasks(masks, plan({ exclusions: [
    { productId: 25, reason: 'Face selection is stale: the evaluated surface geometry changed' },
    { productId: 35, reason: 'Face masks currently apply to converted occurrence bodies only; this object already has a direct tessellated Body' },
    { productId: 45, reason: 'Evaluated appearance currently requires one unambiguous source surface' }] }), label);
  assert.deepEqual([...stale.masks.keys()], [45], 'an unrelated exclusion keeps its mask for the next plan');
  assert.equal(stale.diagnostics.length, 2);
  assert.match(stale.diagnostics[0], /Face selection for IFC object #25 is stale: the evaluated surface geometry changed/);
  assert.match(stale.diagnostics[1], /IFC object #35 was cleared: the object now has a direct tessellated Body/);
  const renumbered = reconcileFaceMasks(masks, plan({ conversions: [{ productId: 45, representationId: 1, sourceGeometryItemId: 2, geometryItemId: 3,
    sourceIndices: [0, 1, 2], surfaceFingerprint: 'b'.repeat(64) }] }), label);
  assert.deepEqual([...renumbered.masks.keys()], [25, 35], 'a conversion reporting another fingerprint cannot keep the old selection');
  assert.match(renumbered.diagnostics[0], /IFC object #45 is stale/);
});

// A placement edit changes the surface the fingerprint binds to whenever the
// body is evaluated in world space (PR-1 contract, the swept box). The real
// planner must refuse the old selection as stale and the workspace must drop
// it with a visible diagnostic rather than reuse its triangle ordinals. A
// mapped tessellation moved by an exactly representable translation keeps its
// identity, so that selection legitimately survives.
test('a placement edit on a masked product invalidates the selection through the real planner (#4404)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  if (!existsSync(wasmUrl)) { t.skip('Run pnpm build:wasm for the native face-mask contract'); return; }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const api = new IfcAPI();
  const request: AppearanceRequest = { schema: 'IFC4', sourceRevision: 'mask', nextExpressId: 100, productIds: [25, 70], imageUri: 'textures/mask.png',
    repeatS: true, repeatT: true, representationPolicy: 'evaluatedOccurrence', mapping: { kind: 'box', frame: 'world', origin: [0, 0, 0], metresPerTile: [1, 1, 1] } };
  const planOn = (source: Uint8Array, extra: Partial<AppearanceRequest> = {}) =>
    JSON.parse(new TextDecoder().decode(api.planAppearance(source, JSON.stringify({ ...request, ...extra })))) as AppearancePlan;
  const conversion = (result: AppearancePlan, productId: number) => result.conversions!.find(item => item.productId === productId)!;
  try {
    const before = planOn(faceMaskProductSource());
    assert.deepEqual(before.exclusions, []);
    assert.equal(conversion(before, 25).sourceIndices.length, 6, 'the quad evaluates to two source triangles');
    assert.equal(conversion(before, 70).sourceIndices.length, 36, 'the box evaluates to twelve source triangles');
    let masks: FaceMasks = new Map([[25, mask(25, [0], conversion(before, 25).surfaceFingerprint!)], [70, mask(70, [0, 1, 2], conversion(before, 70).surfaceFingerprint!)]]);
    const masked = planOn(faceMaskProductSource(), { faceMasks: faceMaskRequests(masks, [25, 70]) });
    assert.deepEqual(masked.exclusions, []);
    assert.deepEqual(conversion(masked, 25).maskedTriangles, [0]);
    assert.deepEqual(conversion(masked, 70).maskedTriangles, [0, 1, 2]);
    assert.equal(reconcileFaceMasks(masks, masked, label).masks, masks, 'matching fingerprints keep both selections');
    const moved = planOn(faceMaskProductSource({ movedPlacement: true }), { faceMasks: faceMaskRequests(masks, [25, 70]) });
    assert.deepEqual(moved.exclusions.map(item => item.productId), [70]);
    assert.match(moved.exclusions[0].reason, /^Face selection is stale/);
    assert.deepEqual(conversion(moved, 25).maskedTriangles, [0], 'an exactly representable move of a mapped tessellation keeps its surface identity');
    const reconciled = reconcileFaceMasks(masks, moved, label);
    assert.deepEqual([...reconciled.masks.keys()], [25]);
    assert.equal(reconciled.diagnostics.length, 1);
    assert.match(reconciled.diagnostics[0], /Face selection for IFC object #70 is stale/);
    masks = reconciled.masks;
    // Without the stale mask the moved box converts whole and reports its new identity.
    const replanned = planOn(faceMaskProductSource({ movedPlacement: true }), { faceMasks: faceMaskRequests(masks, [25, 70]) });
    assert.deepEqual(replanned.exclusions, []);
    assert.notEqual(conversion(replanned, 70).surfaceFingerprint, conversion(before, 70).surfaceFingerprint);
    assert.equal(conversion(replanned, 70).maskedTriangles, undefined);
    assert.equal(reconcileFaceMasks(masks, replanned, label).masks, masks);
  } finally { api.free(); }
});
