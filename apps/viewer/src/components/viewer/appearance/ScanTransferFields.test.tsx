/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { cleanup, render, type } from '@/test/render';
import { emptyPlacementState } from '@/lib/model-placement/state';
import type { MeshTransferPlan } from '@/lib/appearance/scan/transfer-types';
import type { ScanRegistrationReport } from '@/lib/appearance/scan/types';
import { ScanTransferFields } from './ScanTransferFields';
import { useScanTransfer } from './useScanTransfer';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); });
let read: ReturnType<typeof useScanTransfer> | undefined;
function Harness({ coverage, pointSource }: { coverage?: MeshTransferPlan['transfer']; pointSource?: boolean }) {
  const transfer = useScanTransfer({ targetId: 'target', session: null, result: null, stale: false, busy: false, applyAppearance: async () => {} });
  read = transfer;
  return <ScanTransferFields transfer={{ ...transfer, ...(coverage ? { coverage } : {}), ...(pointSource ? { pointSource } : {}) }} disabled={false} />;
}
function mount(coverage?: MeshTransferPlan['transfer'], pointSource?: boolean) {
  useViewerStore.setState({ models: new Map([['target', fixtureModel('target')]]), mutationViews: new Map(), mutationVersion: 0, modelPlacement: emptyPlacementState(), collabRoomId: null });
  return render(<Harness coverage={coverage} pointSource={pointSource} />);
}
const label = 'Maximum depth behind the IFC surface (m)';
const pointLabels = ['Point support radius (m)', 'Point surface band (m)', 'Minimum supporting points', 'Maximum supporting points'];

test('behind-surface limit defaults to the project tolerance and its control reaches the transfer request settings (#4381)', () => {
  const ui = mount();
  assert.equal(read!.settings.maxBehindMetres, read!.settings.toleranceMetres, 'a registration accepted at the default tolerance is not refused behind the face only');
  const input = ui.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(input, 'behind-surface control is offered with the other sampling criteria');
  assert.equal(input.value, '0.01');
  type(input, '0.02');
  assert.equal(read!.settings.maxBehindMetres, 0.02);
  assert.equal(input.value, '0.02');
  assert.equal(read!.settings.maxDistanceMetres, 0.02, 'other sampling criteria are untouched');
});

test('coverage report names samples refused behind the surface beside the other unknown reasons (#4381)', () => {
  const counts = { centroidSamples: 2, observedCentroidSamples: 1, rasterInteriorTexels: 4096, observedRasterInteriorTexels: 1800, samples: 8424, observedSamples: 3426,
    unknownDistanceSamples: 0, unknownNormalSamples: 4212, unknownAmbiguousSamples: 38, unknownBehindSamples: 748, unknownSparseSamples: 0, observedAreaEstimateM2: 0.813, unknownAreaEstimateM2: 1.187 };
  const { registration } = { registration: (JSON.parse(readFileSync(new URL('../../../../../../docs/architecture/evidence/scan-alignment-workbench/good.json', import.meta.url), 'utf8')) as { result: { report: ScanRegistrationReport } }).result.report };
  const ui = mount({ preparedSha256: 'prepared', source: { kind: 'mesh', orientation: null, pointCount: null }, budget: { workUsed: 1, workLimit: 128_000_000 }, registrationSha256: 'registration', registration, applicable: true, coverage: counts,
    items: [{ ...counts, productId: 10, geometryItemId: 3 }], exclusions: [], diagnostics: [] });
  const report = ui.querySelector('[aria-label="Scan transfer coverage"]');
  assert.ok(report);
  const n = (value: number) => value.toLocaleString();
  assert.ok(report.textContent!.includes(`Unknown: 0 too far · ${n(4212)} incompatible normals · 38 ambiguous · 748 behind the surface.`), report.textContent!);
  assert.ok(report.textContent!.includes(`${n(3426)} observed samples of ${n(8424)}.`));
  assert.ok(!report.textContent!.includes('too sparse') && !report.textContent!.includes('orientation'), 'mesh sources report no point-only reasons');
  for (const pointLabel of pointLabels) assert.equal(ui.querySelector(`input[aria-label="${pointLabel}"]`), null, `${pointLabel} is a point-source control`);
});

test('point sources expose their fit controls and report sparse samples and the orientation source (#4381)', () => {
  const counts = { centroidSamples: 12, observedCentroidSamples: 2, rasterInteriorTexels: 105114, observedRasterInteriorTexels: 33841, samples: 105126, observedSamples: 33843,
    unknownDistanceSamples: 63591, unknownNormalSamples: 793, unknownAmbiguousSamples: 700, unknownBehindSamples: 119, unknownSparseSamples: 6080, observedAreaEstimateM2: 8.197, unknownAreaEstimateM2: 17.085 };
  const { registration } = { registration: (JSON.parse(readFileSync(new URL('../../../../../../docs/architecture/evidence/scan-alignment-workbench/good.json', import.meta.url), 'utf8')) as { result: { report: ScanRegistrationReport } }).result.report };
  const ui = mount({ preparedSha256: 'prepared', source: { kind: 'points', orientation: 'target-referenced', pointCount: 465029 }, budget: { workUsed: 43537518, workLimit: 128_000_000 }, registrationSha256: 'registration', registration, applicable: true, coverage: counts,
    items: [{ ...counts, productId: 216, geometryItemId: 3 }], exclusions: [], diagnostics: [] }, true);
  const n = (value: number) => value.toLocaleString();
  const inputs = pointLabels.map(pointLabel => ui.querySelector<HTMLInputElement>(`input[aria-label="${pointLabel}"]`));
  assert.ok(inputs.every(Boolean), 'all four point fit controls are offered');
  assert.equal(inputs[0]!.value, String(read!.settings.neighborhoodRadiusMetres));
  type(inputs[0]!, '0.05');
  assert.equal(read!.settings.neighborhoodRadiusMetres, 0.05);
  type(inputs[2]!, '8');
  assert.equal(read!.settings.minNeighbors, 8);
  assert.equal(read!.settings.maxBehindMetres, read!.settings.toleranceMetres, 'shared sampling criteria are untouched');
  const report = ui.querySelector('[aria-label="Scan transfer coverage"]');
  assert.ok(report);
  assert.ok(report.textContent!.includes(`Unknown: ${n(63591)} too far · 793 incompatible normals · 700 ambiguous · 119 behind the surface · ${n(6080)} too sparse.`), report.textContent!);
  assert.ok(report.textContent!.includes(`Point-cloud source of ${n(465029)} points; sample orientation from the IFC face being sampled (target-referenced).`), report.textContent!);
  assert.ok(ui.textContent!.includes('attributed to its nearest face only'), 'the point-source note states the nearest-face rule, not an unconditional guarantee');
});
