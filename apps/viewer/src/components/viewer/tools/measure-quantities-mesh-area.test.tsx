/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Component-level regression coverage for two defects an adversarial review
 * of 85ebf7d1 (#2645) confirmed against `MeasureQuantities.tsx`'s mesh-area
 * path, plus the empty-mesh labelling question it raised as a hypothesis
 * (independently flagged by CodeRabbit on the same PR):
 *
 * 1. The mesh-area lookup used to sit AFTER `if (!store) continue` in the
 *    per-ref loop, even though mesh area has no store dependency at all — so
 *    a selected element whose model had mesh geometry but no `IfcDataStore`
 *    had its already-computed area silently discarded. Worst case: every
 *    selected ref lacked a store and the panel claimed no mesh area could be
 *    measured, despite having computed some.
 * 2. `collectMeshAreas` summed submeshes with no per-submesh finiteness
 *    check, so one out-of-range vertex index in one submesh (`NaN`) zeroed
 *    the WHOLE occurrence via `rollupMeshArea`'s finiteness guard — including
 *    its other, good submeshes' contribution.
 *
 * `measure-parity.test.tsx` already exercises this panel end to end for
 * frame/unit correctness and must stay unmodified per the review's own
 * standard; this file adds the store-independence and corrupt-submesh
 * coverage that PR did not have.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store/index.js';
import { ToolOverlays } from '../ToolOverlays.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderNode(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TooltipProvider>{node}</TooltipProvider>);
  });
  mounted.push({ root, container });
  return container;
}

const render = (): HTMLElement => renderNode(<ToolOverlays />);

function openSection(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  assert.ok(button, `no section button labelled "${label}" on the measure panel`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

function federatedModel(over: Record<string, unknown>) {
  return {
    id: 'm',
    name: 'model',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    idOffset: 0,
    maxExpressId: 100000,
    loadedAt: 1,
    ...over,
  } as never;
}

beforeEach(() => {
  unmountAll();
  useViewerStore.setState({
    activeTool: 'measure',
    measurements: [],
    activeMeasurement: null,
    pendingMeasurePoint: null,
    measureReferencePoint: null,
    selectedEntity: null,
    selectedEntitiesSet: new Set<string>(),
    models: new Map(),
    ifcDataStore: null,
    geometryResult: null,
    unitDisplayOverrides: {},
  });
});

after(() => {
  unmountAll();
});

describe('mesh area survives a store-less model (defect 1, review of 85ebf7d1)', () => {
  it('reports a mesh area total for a selected element whose model has no IfcDataStore', () => {
    // Right triangle, area 6 (legs 3 and 4) — no `ifcDataStore` on this model
    // at all, which is the exact repro: mesh geometry present, store absent.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:42']),
      models: new Map([['m1', federatedModel({
        id: 'm1',
        ifcDataStore: null,
        geometryResult: {
          meshes: [{ expressId: 42, positions: [0, 0, 0, 3, 0, 0, 0, 4, 0], indices: [0, 1, 2] }],
        },
      })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /Area mesh\s*6 m²/, `store-less mesh area was dropped: ${text}`);
    assert.doesNotMatch(
      text,
      /no triangulated mesh area could be measured/,
      `panel falsely claimed no mesh area, despite computing one: ${text}`,
    );
  });

  it('still counts that element toward "could not be resolved to a loaded model"', () => {
    // The mesh-area fix must not also silently resolve declared quantities —
    // `withoutStore` still fires for the SAME ref; only mesh area escapes it.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:42']),
      models: new Map([['m1', federatedModel({
        id: 'm1',
        ifcDataStore: null,
        geometryResult: {
          meshes: [{ expressId: 42, positions: [0, 0, 0, 3, 0, 0, 0, 4, 0], indices: [0, 1, 2] }],
        },
      })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /could not be resolved to a loaded model/, text);
  });
});

describe('a corrupt submesh does not zero its occurrence\'s mesh area (defect 2)', () => {
  it('keeps the good submesh\'s area and flags the occurrence as a partial total', () => {
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['legacy:42']),
      ifcDataStore: null,
      geometryResult: {
        meshes: [
          // Good submesh, area 6.
          { expressId: 42, occurrenceKey: 'occ-42', positions: [0, 0, 0, 3, 0, 0, 0, 4, 0], indices: [0, 1, 2] },
          // Corrupt submesh: index 5 is out of range for a 3-vertex array.
          { expressId: 42, occurrenceKey: 'occ-42', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 5] },
        ],
      } as never,
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /Area mesh\s*6 m²/, `the good submesh's area was discarded: ${text}`);
    assert.match(
      text,
      /invalid vertex data/,
      `a partial mesh-area total must say so, not read as complete: ${text}`,
    );
  });
});

describe('a present-but-empty mesh record reads as no mesh, not measured-zero (CodeRabbit)', () => {
  it('does not count toward "Area mesh" and is reported as no triangulated mesh', () => {
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['legacy:42']),
      ifcDataStore: null,
      geometryResult: {
        meshes: [{ expressId: 42, occurrenceKey: 'occ-42', positions: [], indices: [] }],
      } as never,
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(
      text,
      /no triangulated mesh area could be measured/,
      `an empty mesh record must not read as a measured zero: ${text}`,
    );
    assert.doesNotMatch(text, /Area mesh/, text);
  });
});
