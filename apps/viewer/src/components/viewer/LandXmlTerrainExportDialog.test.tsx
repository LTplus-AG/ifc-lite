/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "LandXML (terrain)" export dialog (#7600). The producer is a stub
 * processor injected through the dialog's `createProcessor` seam; what is
 * under test is the dialog's contract around it: candidates come from the live
 * selection, the producer runs as a preflight when the dialog opens and when
 * the selection changes, Export is offered only when that preflight accepted,
 * a refusal shows the producer's reason, and Export downloads the preflight's
 * document rather than running the producer again.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { contiguousSourceBytes } from '@ifc-lite/parser';
import type { LandXmlTerrainExport, LandXmlTerrainExportOptions } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { render, cleanup, click, waitFor, advance, type as typeInto } from '@/test/render';
import { clearDownloads, downloadedNames } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import type { LandXmlTerrainProcessor } from '@/lib/export/landXmlTerrainExport';
import { LandXmlTerrainExportDialog } from './LandXmlTerrainExportDialog';

const initialState = useViewerStore.getState();
const SOURCE = new TextEncoder().encode('ISO-10303-21;');

const DOCUMENT: LandXmlTerrainExport = {
  xml: '<?xml version="1.0"?><LandXML version="1.2"><Surfaces/></LandXML>',
  crsName: 'CH1903+ / LV95',
  surfaces: [{ productId: 10, globalId: '2N1qq6ar5Bhw1Gw0rrS$Hn', name: 'Gelände', points: 1234, faces: 2400 }],
};

function siteModel() {
  const model = fixtureModel('Site.ifc', {
    entities: [
      { expressId: 10, type: 'IfcGeographicElement', name: 'Gelände' },
      { expressId: 12, type: 'IfcWall', name: 'Wall' },
    ],
  });
  // The preflight reads the model's (edited) STEP bytes; an unedited model
  // hands over its retained source.
  Object.assign(model.ifcDataStore!, { source: contiguousSourceBytes(SOURCE), schemaVersion: 'IFC4' });
  return model;
}

function stubProcessor(exportImpl: LandXmlTerrainProcessor['exportLandXmlTerrain']) {
  const calls = { created: 0, disposed: 0, ids: [] as number[][], bytes: [] as Uint8Array[], options: [] as (LandXmlTerrainExportOptions | undefined)[] };
  const create = (): LandXmlTerrainProcessor => {
    calls.created += 1;
    return {
      init: async () => undefined,
      exportLandXmlTerrain: (bytes, ids, options) => {
        calls.bytes.push(bytes);
        calls.options.push(options);
        calls.ids.push([...ids]);
        return exportImpl(bytes, ids, options);
      },
      dispose: () => {
        calls.disposed += 1;
      },
    };
  };
  return { create, calls };
}

function select(...expressIds: number[]): void {
  act(() => {
    useViewerStore.setState({ selectedEntitiesSet: new Set(expressIds.map((id) => `Site.ifc:${id}`)) });
  });
}

function open(): void {
  const trigger = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('LandXML'));
  assert.ok(trigger, 'the dialog trigger renders');
  click(trigger);
}

function exportButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Export');
  assert.ok(button, 'the dialog renders its Export action');
  return button;
}

const text = () => document.body.textContent ?? '';

/** Open a Radix Select whose trigger shows `current` and choose `option`. */
async function choose(current: string, option: string): Promise<void> {
  const trigger = [...document.body.querySelectorAll('button[role="combobox"]')].find((b) => b.textContent === current);
  assert.ok(trigger, `a Select showing "${current}" must render`);
  click(trigger);
  await advance(0);
  const item = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === option);
  assert.ok(item, `option "${option}" must render`);
  click(item);
  await advance(0);
}

beforeEach(() => {
  useViewerStore.setState({ ...fixtureModels(siteModel()), selectedEntitiesSet: new Set() });
  clearDownloads();
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

describe('LandXmlTerrainExportDialog (#7600)', () => {
  it('asks for a terrain selection and keeps Export disabled when nothing qualifies', () => {
    const { create, calls } = stubProcessor(() => DOCUMENT);
    select(12);
    render(<LandXmlTerrainExportDialog surface="ribbon" createProcessor={create} />);
    open();

    assert.match(text(), /Select a terrain/);
    assert.match(text(), /IfcGeographicElement or IfcSite/);
    assert.match(text(), /1 selected object is not a terrain and is left out/);
    assert.equal(exportButton().disabled, true);
    assert.equal(calls.created, 0, 'no preflight runs without a candidate');
  });

  it('shows the producer refusal verbatim and keeps Export disabled', async () => {
    const reason = '#10 IfcGeographicElement "Gelände": no IfcMapConversion in the project';
    const { create, calls } = stubProcessor(() => {
      throw new Error(`TERRAIN_REFUSED: ${reason}`);
    });
    select(10);
    render(<LandXmlTerrainExportDialog surface="ribbon" createProcessor={create} />);
    open();

    await waitFor(() => text().includes(reason), 'the refusal reason renders');
    assert.match(text(), /This selection cannot be exported/);
    assert.equal(exportButton().disabled, true);
    assert.deepEqual(calls.ids, [[10]]);
    assert.equal(calls.disposed, 1, 'the processor is freed after a refusal');
  });

  it('re-checks when the selection changes, then exports with the chosen units, precision and names', async () => {
    const { create, calls } = stubProcessor(() => DOCUMENT);
    const captured: Blob[] = [];
    const objectUrl = mock.method(URL, 'createObjectURL', (blob: Blob) => {
      captured.push(blob);
      return 'blob:landxml-terrain';
    });
    const completions: Record<string, unknown>[] = [];
    const analytics = mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      if (event === 'export_completed') completions.push(properties);
    });
    try {
      select(12);
      render(<LandXmlTerrainExportDialog surface="palette" createProcessor={create} />);
      open();
      assert.match(text(), /Select a terrain/);

      // Selecting the terrain while the dialog is open runs the preflight.
      select(10, 12);
      await waitFor(() => document.body.querySelector('input[aria-label="Name for surface Gelände"]') !== null, 'the surface summary renders');
      assert.deepEqual(calls.ids, [[10]], 'only the terrain is sent to the producer');
      assert.deepEqual([...calls.bytes[0]], [...SOURCE], 'the producer reads the model bytes');
      assert.match(text(), /1 surface/);
      assert.match(text(), /1,234/);
      assert.match(text(), /2,400/);
      assert.match(text(), /Coordinate system: CH1903\+ \/ LV95/);
      assert.match(text(), /1 selected object is not a terrain and is left out/);
      assert.match(text(), /Site_terrain\.xml/, 'the filename preview names the download');

      // Options (#7618): defaults shown, then changed.
      assert.match(text(), /LandXML 1\.2/, 'the Output row names the format');
      await choose('Metres', 'US survey feet');
      assert.match(text(), /Heights are written in international feet/);
      await choose('6 (0.000001)', '3 (0.001)');
      const name = document.body.querySelector<HTMLInputElement>('input[aria-label="Name for surface Gelände"]');
      assert.ok(name, 'each surface name is editable');
      assert.equal(name.value, 'Gelände', 'seeded with the name the preflight would write');
      act(() => typeInto(name, 'Existing ground'));
      assert.equal(calls.ids.length, 1, 'options do not re-run the preflight');

      const button = exportButton();
      assert.equal(button.disabled, false);
      await act(async () => {
        button.click();
      });
      await waitFor(() => downloadedNames().length === 1, 'the download starts');

      assert.deepEqual(downloadedNames(), ['Site_terrain.xml']);
      assert.equal(captured.length, 1);
      assert.equal(captured[0].type, 'application/xml');
      assert.equal(await captured[0].text(), DOCUMENT.xml);
      assert.equal(calls.ids.length, 2, 'Export writes the document with the chosen options');
      assert.deepEqual(calls.ids[1], [10]);
      assert.deepEqual(calls.options[0], {}, 'the preflight runs with the defaults');
      assert.deepEqual(calls.options[1], { linearUnit: 'usSurveyFoot', decimals: 3, surfaceNames: { 10: 'Existing ground' } });
      assert.equal(completions.length, 1);
      assert.equal(completions[0].format, 'landxml');
      assert.equal(completions[0].surface, 'palette');
      assert.equal(typeof completions[0].size_kb, 'number');
      assert.match(text(), /Exported LandXML terrain/);
    } finally {
      objectUrl.mock.restore();
      analytics.mock.restore();
    }
  });
});
