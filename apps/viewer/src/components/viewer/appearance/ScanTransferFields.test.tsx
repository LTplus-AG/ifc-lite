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
function Harness({ coverage }: { coverage?: MeshTransferPlan['transfer'] }) {
  const transfer = useScanTransfer({ targetId: 'target', session: null, result: null, stale: false, busy: false, applyAppearance: async () => {} });
  read = transfer;
  return <ScanTransferFields transfer={coverage ? { ...transfer, coverage } : transfer} disabled={false} />;
}
function mount(coverage?: MeshTransferPlan['transfer']) {
  useViewerStore.setState({ models: new Map([['target', fixtureModel('target')]]), mutationViews: new Map(), mutationVersion: 0, modelPlacement: emptyPlacementState(), collabRoomId: null });
  return render(<Harness coverage={coverage} />);
}
const label = 'Maximum depth behind the IFC surface (m)';

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
    unknownDistanceSamples: 0, unknownNormalSamples: 4212, unknownAmbiguousSamples: 38, unknownBehindSamples: 748, observedAreaEstimateM2: 0.813, unknownAreaEstimateM2: 1.187 };
  const { registration } = { registration: (JSON.parse(readFileSync(new URL('../../../../../../docs/architecture/evidence/scan-alignment-workbench/good.json', import.meta.url), 'utf8')) as { result: { report: ScanRegistrationReport } }).result.report };
  const ui = mount({ preparedSha256: 'prepared', registrationSha256: 'registration', registration, applicable: true, coverage: counts,
    items: [{ ...counts, productId: 10, geometryItemId: 3 }], exclusions: [], diagnostics: [] });
  const report = ui.querySelector('[aria-label="Scan transfer coverage"]');
  assert.ok(report);
  const n = (value: number) => value.toLocaleString();
  assert.ok(report.textContent!.includes(`Unknown: 0 too far · ${n(4212)} incompatible normals · 38 ambiguous · 748 behind the surface.`), report.textContent!);
  assert.ok(report.textContent!.includes(`${n(3426)} observed samples of ${n(8424)}.`));
});
