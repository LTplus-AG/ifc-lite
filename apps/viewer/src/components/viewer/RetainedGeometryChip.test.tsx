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
import { act } from 'react';
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
  act(() => useViewerStore.setState({ models: new Map(), activeModelId: null, selectedEntityId: null }));
});

describe('#7955 M2-C retained chip', () => {
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
    seed(summary({ published: 1, refused: [{ expressId: 20, ifcType: 'IfcDoor', code: 'opening_strategy' }], cancelled: 0, completeness: 'running' }));
    mount();
    assert.equal(chip()?.textContent, 'Retained · shape-only · 2/4 products' + 'running');
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
