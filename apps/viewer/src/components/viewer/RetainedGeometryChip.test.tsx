/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955 M2-C: the retained chip and the Retained geometry panel, mounted
 * against a store-seeded retained model.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, Profiler } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import type { RetainedGeometrySummary } from '@/store/retainedGeometry';
import { chooseGeometryKernel, requestedGeometryKernel } from '@/store/geometryKernel';
import { ViewportHud } from '@/components/viewport-ui/hud';
import { beginGeometryKernel } from '@/hooks/ingest/geometryEventSource';
import { RetainedGeometryChip } from './RetainedGeometryChip';

const SOURCE = new File(['ISO-10303-21;'], 'wall.ifc');

function summary(patch: Partial<RetainedGeometrySummary> = {}): RetainedGeometrySummary {
  return {
    kernel: 'retained', candidates: 4, published: 1, cancelled: 1, completeness: 'incomplete',
    obligationsUnmet: ['IfcAppearance', 'OpeningClosure'],
    refused: [
      { expressId: 30, ifcType: 'IfcWall', code: 'operation_unsupported' },
      { expressId: 20, ifcType: 'IfcDoor', code: 'opening_strategy', origin: { site: 'opening', entity: 77, cause: 'unsupported_profile' } },
      { expressId: 40, ifcType: '', code: 'cancelled' },
    ],
    ...patch,
  };
}

function seed(retainedGeometry: RetainedGeometrySummary | undefined, idOffset = 0) {
  const model = {
    id: 'm', name: 'wall.ifc', ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset, maxExpressId: 100, loadState: 'complete',
    sourceFile: SOURCE, retainedGeometry,
  } as FederatedModel;
  act(() => useViewerStore.setState({ models: new Map([['m', model]]), activeModelId: 'm' }));
}

function mount(reloads: File[] = []) {
  return render(<><ViewportHud /><RetainedGeometryChip reload={(file) => { reloads.push(file); }} /></>);
}

const chip = () => document.querySelector<HTMLButtonElement>('[data-retained-chip]');
const panel = () => document.querySelector<HTMLElement>('[data-retained-geometry-panel]');
const rowIds = () => [...document.querySelectorAll<HTMLElement>('[data-retained-row]')].map((row) => Number(row.dataset.retainedRow));

afterEach(() => {
  cleanup();
  chooseGeometryKernel('exact');
  act(() => useViewerStore.setState({ models: new Map(), activeModelId: null, selectedEntityId: null, selectedEntity: null }));
});

describe('#7955 M2-C retained chip', () => {
  it('M11-Z shows final published bands without claiming refused products are complete', () => {
    seed(summary({ published: 3, refused: [{ expressId: 30, ifcType: 'IfcWall', code: 'operation_unsupported' }],
      cancelled: 0, obligationsUnmet: [], completeness: 'incomplete' }));
    mount();
    assert.match(chip()?.textContent ?? '', /Retained · final · 3\/4 products · 1 refused/);
    assert.match(chip()?.title ?? '', /all presentation obligations are discharged/);
    assert.equal(chip()?.dataset.retainedChip, 'incomplete');
    click(chip()!);
    assert.match(panel()?.textContent ?? '', /Published products are final/);
    assert.doesNotMatch(panel()?.textContent ?? '', /Not applied to published products/);
  });
  it('shows nothing for an exact model', () => {
    seed(undefined);
    mount();
    assert.equal(chip(), null);
  });

  it('names the shape-only state, the counts and the explicit incomplete state', () => {
    seed(summary());
    mount();
    assert.equal(chip()?.textContent, 'Retained · shape-only · 1/4 products · 2 refused · 1 cancelled' + 'incomplete');
    assert.equal(chip()?.dataset.retainedChip, 'incomplete');
    assert.match(chip()?.title ?? '', /Not applied: appearance, openings/);
  });

  it('reads complete when every product published, and progress while running', () => {
    seed(summary({ published: 4, refused: [], cancelled: 0, completeness: 'complete' }));
    mount();
    assert.equal(chip()?.textContent, 'Retained · shape-only · 4/4 products · 0 refused' + 'complete');
    cleanup();
    seed(summary({ started: true, published: 1, refused: [{ expressId: 20, ifcType: 'IfcDoor', code: 'opening_strategy' }], cancelled: 0, completeness: 'running' }));
    mount();
    assert.equal(chip()?.textContent, 'Retained · shape-only · 2/4 products' + 'running');
  });

  it('reads starting only before the engine started, not for a started zero-candidate run', () => {
    seed(summary({ candidates: 0, published: 0, refused: [], cancelled: 0, completeness: 'running' }));
    mount();
    assert.equal(chip()?.textContent, 'Retained · shape-only · starting engine' + 'running');
    cleanup();
    seed(summary({ started: true, candidates: 0, published: 0, refused: [], cancelled: 0, completeness: 'running' }));
    mount();
    assert.equal(chip()?.textContent, 'Retained · shape-only · 0/0 products' + 'running');
  });
});

describe('#7955 M2-C Retained geometry panel', () => {
  it('lists every unpublished product; filters by code; sorts; selects the entity', () => {
    seed(summary(), 1000);
    mount();
    click(chip()!);
    assert.ok(panel(), 'the chip opens the panel');
    assert.deepEqual(rowIds(), [20, 30, 40], 'sorted by id');
    assert.match(panel()!.textContent ?? '', /unsupported_profile at opening \(#77\)/);
    assert.match(panel()!.textContent ?? '', /Openings are not supported by the retained kernel yet\./);
    assert.match(panel()!.textContent ?? '', /Not computed: the run stopped before this product\./);

    const select = panel()!.querySelector('select')!;
    act(() => {
      select.value = 'opening_strategy';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.deepEqual(rowIds(), [20]);
    act(() => {
      select.value = '';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

    click(panel()!.querySelector('button[aria-label="Sort by Code"]')!);
    assert.deepEqual(rowIds(), [40, 20, 30], 'cancelled, opening_strategy, operation_unsupported');

    click(panel()!.querySelector('[data-retained-row="30"]')!);
    assert.equal(useViewerStore.getState().selectedEntityId, 1030, 'the global id of #30 in a model offset by 1000');
    assert.deepEqual(useViewerStore.getState().selectedEntity, { modelId: 'm', expressId: 30 }, 'the properties channel follows the row');
  });

  it('"Reload with exact kernel" reloads the whole model with the exact kernel', () => {
    chooseGeometryKernel('retained');
    seed(summary());
    const reloads: File[] = [];
    mount(reloads);
    click(chip()!);
    const reload = [...panel()!.querySelectorAll('button')].find((b) => b.textContent === 'Reload with exact kernel');
    assert.ok(reload);
    click(reload);
    assert.deepEqual(reloads, [SOURCE], 'the same source, as a primary reload');
    assert.equal(requestedGeometryKernel(), 'exact');
    const next = beginGeometryKernel(SOURCE, { kind: 'primary' }, () => {});
    assert.equal(next.kind, 'exact', 'the reload runs on the exact kernel, which writes no retained summary');
    assert.equal(next.events, undefined);
    assert.equal(panel(), null, 'the panel closes');
  });
});

describe('#7955 a large refusal list', () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => ({ expressId: i + 1, ifcType: 'IfcWall', code: i % 2 ? 'operation_unsupported' : 'opening_strategy' }));

  it('does no filter or sort work behind a closed panel, and model updates that leave the summary alone do not re-render the chip', () => {
    // Counts every walk of the refused list (iteration, filter, sort, copy); reading its length is free.
    let walks = 0;
    const walking = new Set<PropertyKey>([Symbol.iterator, 'filter', 'map', 'slice', 'sort', 'forEach', 'reduce']);
    const refused = new Proxy(many(20_000), { get(target, key, receiver) { if (walking.has(key)) walks++; return Reflect.get(target, key, receiver); } });
    const big = summary({ candidates: 20_000, published: 0, cancelled: 0, completeness: 'running', started: true, refused });
    seed(big);
    let commits = 0;
    render(<><ViewportHud /><Profiler id="chip" onRender={() => { commits++; }}><RetainedGeometryChip reload={() => {}} /></Profiler></>);
    assert.ok(chip());
    assert.equal(walks, 0, 'a closed panel neither counts codes nor filters and sorts rows');
    const settled = commits;
    for (let i = 0; i < 5; i++) {
      // Streaming geometry replaces the model record without touching its summary.
      act(() => useViewerStore.setState((state) => {
        const models = new Map(state.models);
        models.set('m', { ...models.get('m')!, loadState: 'streaming-geometry', maxExpressId: 100 + i });
        return { models };
      }));
    }
    assert.equal(commits, settled, 'the chip re-renders on its summary, not on every model update');
    act(() => useViewerStore.setState((state) => {
      const models = new Map(state.models);
      models.set('m', { ...models.get('m')!, retainedGeometry: { ...big, published: 1 } });
      return { models };
    }));
    assert.equal(commits, settled + 1, 'a new summary re-renders it once');
    assert.equal(walks, 0, 'not even when the summary changes');
  });

  it('the open panel renders a bounded number of rows and says so; "Show more" reaches every row', () => {
    seed(summary({ candidates: 20_000, published: 0, cancelled: 0, refused: many(20_000) }));
    mount();
    click(chip()!);
    assert.equal(rowIds().length, 500);
    assert.match(panel()!.querySelector('[data-retained-rows-capped]')?.textContent ?? '', /first 500 of 20000 rows/);
    const select = panel()!.querySelector('select')!;
    assert.match(select.textContent ?? '', /opening_strategy \(10000\)/);
    const more = () => panel()!.querySelector<HTMLButtonElement>('[data-retained-rows-more]');
    click(more()!);
    assert.equal(rowIds().length, 1000);
    assert.match(panel()!.querySelector('[data-retained-rows-capped]')?.textContent ?? '', /first 1000 of 20000 rows/);
    // One code holding almost every row must not hide rows past the first page.
    seed(summary({ candidates: 1_201, published: 0, cancelled: 0, refused: Array.from({ length: 1_201 }, (_, i) => ({ expressId: i + 1, ifcType: 'IfcWall', code: 'operation_unsupported' })) }));
    for (let page = 0; page < 3 && more(); page++) click(more()!);
    assert.equal(rowIds().length, 1_201);
    assert.ok(rowIds().includes(1201), 'the last row is reachable');
    assert.equal(more(), null);
  });
});

