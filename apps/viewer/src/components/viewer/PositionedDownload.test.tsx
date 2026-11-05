/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/download-capture';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, waitFor } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { gaussianPly, installInThreadGaussianWorker } from '@/test/gaussian-loader-harness';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { ZERO_ROTATION } from '@/lib/model-placement/rotation';
import { decodeGaussianFile } from '@/hooks/ingest/gaussianDecode';
import { PositionedDownload } from './PositionedDownload';

const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const button = (name: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === name || b.getAttribute('aria-label') === name);
  assert.ok(el, name); return el;
};
function seed(withSource = true) {
  const model = { ...fixtureModel('capture'), name: 'My Capture.ply', sourceFile: withSource ? gaussianPly('capture.ply', [[1,2,3]]) : undefined,
    gaussianSplat: { handle: {id:1,modelIndex:0}, format: 'gaussian-ply' as const, count:1,shDegree:0 as const,
      sourceCenterBounds: {min:[1,2,3] as [number,number,number],max:[1,2,3] as [number,number,number]},
      placement: identity, sourcePlacement: identity, upAxis:'z' as const, placementOrigin:'source' as const, calibration:'uncalibrated' as const } };
  const placement = emptyPlacementState();
  placement.placements = new Map([['capture',{translation:[10,20,30],rotation:ZERO_ROTATION,locked:false}]]);
  useViewerStore.setState({...fixtureModels(model), modelPlacement:placement});
}
afterEach(() => { cleanup(); clearDownloads(); });

it('download action produces a positioned Gaussian file through real decoding and shared browser download', async () => {
  const worker = installInThreadGaussianWorker();
  const saved = URL.createObjectURL; let blob: Blob | undefined;
  URL.createObjectURL = value => { assert.ok(value instanceof Blob); blob = value; return 'blob:positioned-test'; };
  try {
    seed();
    useViewerStore.getState().openReposition(['capture']);
    render(<PositionedDownload modelId="capture" />);
    click(button('Download positioned file…')); click(button('Download PLY'));
    await waitFor(() => downloadedNames().length > 0, 'positioned PLY download');
    assert.deepEqual(downloadedNames(), ['My Capture-positioned.ply']);
    assert.ok(blob);
    const output = await decodeGaussianFile(new File([blob], 'positioned.ply'));
    assert.deepEqual(output.centerBounds.min,[11,22,33]);
    assert.equal(worker.stats.created,worker.stats.terminated);
  } finally { URL.createObjectURL=saved; worker.restore(); }
});

it('missing source is explained, and cancelling a held decoder cannot download later', async () => {
  seed(false); render(<PositionedDownload modelId="capture" />);
  click(button('Download positioned file…'));
  assert.equal(button('Download PLY').disabled,true);
  assert.match(document.body.textContent ?? '', /original source/);
  cleanup();
  const worker = installInThreadGaussianWorker(); const release=worker.hold();
  try {
    seed(); render(<PositionedDownload modelId="capture" />);
    click(button('Download positioned file…')); click(button('Download PLY'));
    await waitFor(() => worker.stats.created > 0, 'Gaussian export decoder starts');
    click(button('Cancel')); await act(async()=>{ release(); await new Promise(r=>setTimeout(r,20)); });
    assert.deepEqual(downloadedNames(),[]);
    assert.equal(worker.stats.created,worker.stats.terminated);
  } finally { release(); worker.restore(); }
});

it('a single scan exposes its download from the Point Clouds panel', async () => {
  const { PointCloudPanel } = await import('./PointCloudPanel');
  useViewerStore.setState({...fixtureModels({...fixtureModel('scan'),name:'Survey.xyz',pointCloudHandleId:40,
    sourceFile:new File(['1 2 3\n'],'Survey.xyz')}),modelPlacement:emptyPlacementState()});
  render(<PointCloudPanel assetCount={1} triangleCount={0} />);
  click(button('Download positioned file…'));
  assert.match(document.body.textContent ?? '', /Survey.xyz/);
  assert.equal(button('Download PLY').disabled,false);
});

it('#8915 portalled download overlay clicks do not activate the containing model row', () => {
  seed();
  let selections = 0;
  render(<div role="presentation" onClick={() => selections++}><PositionedDownload modelId="capture" /></div>);
  click(button('Download positioned file…'));
  const overlay = document.querySelector<HTMLElement>('[data-state="open"].inset-0');
  assert.ok(overlay, 'dialog overlay is mounted outside the model row');
  click(overlay);
  assert.equal(selections, 0);
  click(button('Close'));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(selections, 0);
});
