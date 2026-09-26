/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5207: an edit made while a lens is active re-evaluates it. The hook must
 * re-run on a live property/attribute edit, not only on lens selection, and
 * the provider must read the edited value.
 *
 * Harness copied from `useLens.model-removal.test.tsx`, whose doc follows:
 *
 * `useLens`'s evaluation effect depends on `[activeLensId, activeLens]` only.
 * It reads `models` / `ifcDataStore` from `getState()` — deliberately NOT
 * subscribed, to avoid re-evaluating on every loading-progress tick — but
 * that means the effect never reruns when the model SET changes: neither on
 * `removeModel` nor on `clearAllModels`.
 *
 * The consequence is not just a dangling reference. `clearAllModels` also
 * resets `federationRegistry` (`nextOffset = 0`), so the NEXT model loaded
 * reuses the exact global-id range the stale `lensColorMap` /
 * `lensAppliedColors` / `lensHiddenIds` / `lensRuleEntityIds` still point at.
 * A lens rule that matched the OLD model's entities keeps reporting matches
 * for whatever entity now lives at the same global id in the NEW model —
 * `useCompareOverlay.ts` (`store.lensAppliedColors`) resends that exact map
 * to the renderer verbatim on compare teardown.
 *
 * Mounts the REAL `useLens()` hook over the REAL store, the same harness
 * shape as `useClash.collab-room-refs.test.tsx`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { Lens } from '@ifc-lite/lens';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { useLens } from './useLens.js';

function ifc4(body: string): string {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', body, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** One rule: colorize the element NAMED 'Renamed' red. */
const WALL_LENS: Lens = {
  id: 'test-name-lens',
  name: 'Renamed',
  rules: [
    {
      id: 'rule-name',
      name: 'Renamed',
      enabled: true,
      groups: [{ combinator: 'AND', rules: [{ kind: 'name', op: 'eq', value: 'Renamed' }] }],
      action: 'colorize',
      color: '#ff0000',
    },
  ],
};

let mounted = false;

function Probe(): null {
  useLens();
  mounted = true;
  return null;
}

let root: Root | null = null;

async function mountProbe(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(mounted, 'useLens must be mounted');
}

async function activateLens(): Promise<void> {
  await act(async () => {
    useViewerStore.setState({ savedLenses: [WALL_LENS], activeLensId: WALL_LENS.id });
  });
}

/** Register + add a model exactly like `useIfcLoader.ts` does: offset from
 *  the federation registry singleton, then `addModel` with that offset. */
async function loadModel(modelId: string, store: IfcDataStore, maxExpressId: number): Promise<void> {
  await act(async () => {
    const idOffset = useViewerStore.getState().registerModelOffset(modelId, maxExpressId);
    useViewerStore.getState().addModel({
      id: modelId,
      name: modelId,
      ifcDataStore: store,
      geometryResult: null,
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: Date.now(),
      fileSize: 0,
      idOffset,
      maxExpressId,
      loadState: 'complete',
    });
  });
}

beforeEach(() => {
  mounted = false;
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({
    savedLenses: [], activeLensId: null,
    lensColorMap: new Map(), lensAppliedColors: null, lensHiddenIds: new Set(),
    lensRuleCounts: new Map(), lensRuleEntityIds: new Map(),
  });
});

describe('useLens re-evaluates after a live edit (#5207)', () => {
  it('renaming an element while the lens is active colors it, without re-selecting the lens', async () => {
    const store = await parse("#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);");
    await mountProbe();
    await loadModel('model-a', store, 1);
    await activateLens();
    assert.equal(useViewerStore.getState().lensColorMap.has(1), false, 'calibration: nothing is named Renamed yet');

    // The view the Properties panel creates on first edit (PropertiesPanel.tsx).
    const view = new MutablePropertyView(store.properties ?? null, 'model-a');
    configureMutationView(view, store);
    await act(async () => {
      useViewerStore.getState().registerMutationView('model-a', view);
    });

    await act(async () => {
      useViewerStore.getState().setAttribute('model-a', 1, 'Name', 'Renamed', 'Wall A');
    });

    assert.equal(
      useViewerStore.getState().lensColorMap.get(1), '#ff0000',
      'the active lens must pick up the edited Name on its own',
    );
  });
});
