/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { model, parseHelloWall, parseOther, seed, viewerHost } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });

test('exports.mergedStep keeps a georeference-only edit, as exports.modelStep does (#10669)', async () => {
  resetFeaturesForTest();
  seed([model('A', await parseHelloWall()), model('B', await parseOther())]);
  useViewerStore.setState({ georefMutations: new Map([['A', {
    projectedCRS: { name: 'EPSG:2056', geodeticDatum: 'CH1903+', mapUnit: 'METRE' },
    mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
  }]]) });
  const host = viewerHost();
  const exported = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'exports.mergedStep', input: {
    schema: 'IFC4', include_geometry: true, apply_mutations: true, visible_only: false, section_mode: 'trim', model_ids: ['A', 'B'], unit_reconciliation: 'assume-shared',
  } }, { canEdit: () => true });
  assert.equal(exported.isError, false, exported.text);
  const { artifact_id } = (exported.structured as { result: { artifact: { artifact_id: string } } }).result.artifact;
  // The read tool pages the artifact; the georeference lines come after the first page.
  const pages: Buffer[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = (await dispatchMainViewerTool(host, 'viewer_artifact_read', { artifact_id, offset })).structured as { data: string; next_offset: number | null };
    pages.push(Buffer.from(page.data, 'base64')); offset = page.next_offset;
  }
  const text = Buffer.concat(pages).toString('utf8');
  assert.match(text, /IFCPROJECTEDCRS\('EPSG:2056'/);
  assert.match(text, /IFCMAPCONVERSION\(#\d+,#\d+,2600000\.,1200000\.,500\.,1\.,0\.,1\.\);/);
});
