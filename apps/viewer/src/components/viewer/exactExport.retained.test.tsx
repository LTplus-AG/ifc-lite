/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { render, click, type, cleanup, waitFor } from '@/test/render';
import { UsdExportDialog } from './UsdExportDialog';
import { EnergyModelExportDialog } from './EnergyModelExportDialog';
import { CesiumIonExportDialog } from './CesiumIonExportDialog';
import '@/lib/retained/retainedLoad';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); });
function button(name: string) {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
  assert.ok(found, name);
  return found;
}

// #8415: launch-time disabling cannot protect a dialog already open during a kernel change.
for (const format of ['USD', 'energy', 'ion'] as const) {
  it(`${format} refuses submission when an open exact-model dialog becomes retained`, async () => {
    await seedCoincidentWalls(1);
    const exact = useViewerStore.getState().models.get('A')!;
    useViewerStore.setState({ models: new Map([['A', {
      ...exact, sourceFile: new File(['unused: submission must refuse before reading'], 'A.ifc'),
    }]]) });
    render(format === 'USD' ? <UsdExportDialog surface="ribbon" />
      : format === 'energy' ? <EnergyModelExportDialog surface="ribbon" />
      : <CesiumIonExportDialog surface="ribbon" upload={async () => assert.fail('retained STEP must not upload')} />);
    click(button(format === 'USD' ? 'Export USD' : format === 'energy' ? 'Energy Model' : 'Upload to Cesium ion'));
    if (format === 'ion') type(document.querySelector<HTMLInputElement>('#ion-token')!, 'test-token');
    act(() => useViewerStore.setState({ models: new Map([['A', {
      ...useViewerStore.getState().models.get('A')!,
      retainedGeometry: { kernel: 'retained', candidates: 2, published: 2, refused: [],
        cancelled: 0, completeness: 'complete', obligationsUnmet: [] },
    }]]) }));
    const submit = button(format === 'USD' ? 'Export' : format === 'energy' ? 'Export HBJSON' : 'Upload');
    assert.equal(submit.disabled, false, 'the open dialog still exposes submission');
    click(submit);
    await waitFor(() => /Reload that model with the exact kernel/.test(document.body.textContent ?? ''),
      'live retained policy must refuse before source reading, meshing or uploading');
  });
}
