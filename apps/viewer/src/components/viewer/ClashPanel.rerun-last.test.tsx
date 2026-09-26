/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5818: the Clash panel's Re-run repeats the run that produced the result
 * on screen. It used to call `runAll()` unconditionally, so after "Find
 * duplicates" or a single preset the user got the all-elements self-clash
 * instead, a different and usually much larger result.
 *
 * Driven through the real panel and the real `useClash` over parsed models
 * and real meshes, at 1 model and at N models (second model id-offset).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

const TWO_WALLS = [
  "#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);",
  "#2=IFCWALL('0bbbbbbbbbbbbbbbbbbbbb',$,'Wall B',$,$,$,$,$,.STANDARD.);",
].join('\n');

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  // disableWorkerScan keeps the scan in-process (no Worker under node:test).
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A unit box (12 triangles) with its min corner at `(dx, 0, 0)`. */
function boxMesh(expressId: number, dx: number): MeshData {
  const positions = new Float32Array([
    dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0,
    dx, 0, 1, dx + 1, 0, 1, dx + 1, 1, 1, dx, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  return {
    expressId,
    ifcType: 'IfcWall',
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
  };
}

function geometry(meshes: MeshData[]): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } };
  const coordinateInfo: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: false,
  };
  return { meshes, totalTriangles: 12 * meshes.length, totalVertices: 8 * meshes.length, coordinateInfo };
}

function model(id: string, idOffset: number, store: IfcDataStore, meshes: MeshData[]): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: store,
    geometryResult: geometry(meshes),
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset,
    maxExpressId: 2,
  };
}

/** The shared store's presets; one case deletes a preset and must hand them back. */
const INITIAL_PRESETS = useViewerStore.getState().clashPresets;

let root: Root | null = null;
let container: HTMLElement | null = null;

/** One model holding two coincident walls, or two models holding one each. */
async function seed(modelCount: 1 | 2): Promise<void> {
  const store = await parse(TWO_WALLS);
  const models = modelCount === 1
    ? [model('A', 0, store, [boxMesh(1, 0), boxMesh(2, 0)])]
    : [model('A', 0, store, [boxMesh(1, 0)]), model('B', 100, await parse(TWO_WALLS), [boxMesh(2, 0)])];
  useViewerStore.setState({
    models: new Map(models.map((m) => [m.id, m])),
    activeModelId: 'A',
    clashResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<ClashPanel />); });
}

function buttonByText(text: string): HTMLElement {
  const el = [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(el, `button "${text}" rendered`);
  return el;
}

async function clickAndSettle(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The run waits a frame (bounded by a timer) before scanning.
    await new Promise((r) => setTimeout(r, 300));
  });
  await act(async () => {
    const until = Date.now() + 10_000;
    while (useViewerStore.getState().clashRunning && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  });
}

function ruleIds(): string[] {
  return useViewerStore.getState().clashResult?.rulesRun.map((r) => r.id) ?? [];
}

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  useViewerStore.setState({ models: new Map(), activeModelId: null, clashResult: null, clashGroups: null, clashError: null, clashRunning: false, clashPresets: INITIAL_PRESETS });
});

for (const modelCount of [1, 2] as const) {
  describe(`ClashPanel Re-run repeats the last run kind (#5818), ${modelCount} model(s)`, () => {
    it('#5820 keeps a stale result and the banner re-runs the same analysis', async () => {
      await seed(modelCount);
      await clickAndSettle(buttonByText('Find duplicates'));
      const previous = useViewerStore.getState().clashResult;
      assert.ok(previous);

      await act(async () => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
      assert.equal(useViewerStore.getState().clashResult, previous);
      const banner = container!.querySelector('output');
      assert.match(banner?.textContent ?? '', /model changed/i);
      const rerun = banner?.querySelector('button');
      assert.ok(rerun);
      await clickAndSettle(rerun);
      assert.notEqual(useViewerStore.getState().clashResult, previous);
      assert.equal(container!.querySelector('output'), null, 'fresh result clears the stale banner');
    });

    it('repeats the duplicate scan after "Find duplicates"', async () => {
      await seed(modelCount);
      await clickAndSettle(buttonByText('Find duplicates'));
      const first = useViewerStore.getState().clashResult;
      assert.ok(first, 'duplicate scan published');
      assert.match(useViewerStore.getState().clashGroups?.[0]?.title ?? '', /^2 coincident /);
      const firstRules = ruleIds();
      assert.ok(!firstRules.includes('all-clashes'));

      assert.equal(buttonByText('Re-run').getAttribute('title'), 'Re-run the duplicate scan');
      await clickAndSettle(buttonByText('Re-run'));
      const again = useViewerStore.getState().clashResult;
      assert.ok(again && again !== first, 'Re-run published a fresh result');
      assert.deepEqual(ruleIds(), firstRules, 'Re-run repeated the duplicate scan, not "Detect all"');
      assert.match(useViewerStore.getState().clashGroups?.[0]?.title ?? '', /^2 coincident /);
    });

    it('repeats the same preset after a preset run', async () => {
      await seed(modelCount);
      const preset = useViewerStore.getState().clashPresets.find((p) => p.enabled);
      assert.ok(preset, 'an enabled built-in preset exists');
      await clickAndSettle(buttonByText(preset.name));
      assert.deepEqual(ruleIds(), [preset.id]);

      const reRun = buttonByText('Re-run');
      assert.equal(reRun.getAttribute('title'), `Re-run rule "${preset.name}"`);
      const first = useViewerStore.getState().clashResult;
      await clickAndSettle(reRun);
      assert.notEqual(useViewerStore.getState().clashResult, first, 'Re-run published a fresh result');
      assert.deepEqual(ruleIds(), [preset.id], 'Re-run repeated the preset, not "Detect all"');
    });

    it('reports a deleted preset instead of a silent no-op Re-run', async () => {
      await seed(modelCount);
      const preset = useViewerStore.getState().clashPresets.find((p) => p.enabled);
      assert.ok(preset);
      await clickAndSettle(buttonByText(preset.name));
      const first = useViewerStore.getState().clashResult;
      useViewerStore.setState({ clashPresets: useViewerStore.getState().clashPresets.filter((p) => p.id !== preset.id) });
      await clickAndSettle(buttonByText('Re-run'));
      assert.equal(useViewerStore.getState().clashResult, first, 'nothing ran');
      assert.match(String(useViewerStore.getState().clashError), /no longer exists/);
    });

    it('repeats the enabled rule set after a rule-set run', async () => {
      await seed(modelCount);
      await clickAndSettle(buttonByText('Discipline matrix'));
      const first = ruleIds();
      assert.ok(first.length > 1, 'the rule set ran several rules');
      const reRun = buttonByText('Re-run');
      assert.equal(reRun.getAttribute('title'), 'Re-run the enabled rule set');
      const firstResult = useViewerStore.getState().clashResult;
      await clickAndSettle(reRun);
      assert.notEqual(useViewerStore.getState().clashResult, firstResult);
      assert.deepEqual(ruleIds(), first, 'Re-run repeated the rule set, not "Detect all"');
    });

    it('still repeats "Detect all" after a Detect-all run', async () => {
      await seed(modelCount);
      await clickAndSettle(buttonByText('Detect all clashes'));
      assert.deepEqual(ruleIds(), ['all-clashes']);
      const first = useViewerStore.getState().clashResult;
      await clickAndSettle(buttonByText('Re-run'));
      assert.notEqual(useViewerStore.getState().clashResult, first);
      assert.deepEqual(ruleIds(), ['all-clashes']);
    });
  });
}
