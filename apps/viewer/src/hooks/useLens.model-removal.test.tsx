/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
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
import { useViewerStore } from '@/store';
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

/** A lens with one rule: colorize every IfcWall red. Non-walls get no entry. */
const WALL_LENS: Lens = {
  id: 'test-wall-lens',
  name: 'Walls',
  rules: [
    {
      id: 'rule-wall',
      name: 'Walls',
      enabled: true,
      criteria: { type: 'ifcType', ifcType: 'IfcWall' },
      action: 'colorize',
      color: '#ff0000',
    },
  ],
};

let api: ReturnType<typeof useLens> | null = null;

function Probe(): null {
  api = useLens();
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
  assert.ok(api, 'useLens must be mounted');
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
  api = null;
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

describe('useLens: model-set changes must invalidate the evaluation (#2853-class)', () => {
  it('CALIBRATION: a live wall is colored while its model is still loaded', async () => {
    const store = await parse("#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);");
    await mountProbe();
    await loadModel('model-a', store, 1);
    await activateLens();

    const s = useViewerStore.getState();
    assert.equal(s.lensColorMap.size, 1, 'the wall must be colored while its model is present');
    assert.equal(s.lensColorMap.get(1), '#ff0000');
  });

  it('DEFECT: a stale color from a removed model misresolves onto a reused global id', async () => {
    const storeA = await parse("#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);");
    await mountProbe();
    await loadModel('model-a', storeA, 1);
    await activateLens();

    const before = useViewerStore.getState();
    assert.equal(before.lensColorMap.get(1), '#ff0000', 'sanity: wall A colored red');

    // Drop every model — this is what removeModel/clearAllModels do, and it
    // resets the federation registry's offset counter.
    await act(async () => {
      useViewerStore.getState().clearAllModels();
    });

    // Load a DIFFERENT model whose entity at the SAME expressId is a column,
    // not a wall — the lens rule must not match it. Because clearAllModels
    // reset the registry, this model is re-offered offset 0: the exact
    // global-id range the stale entries still reference.
    const storeB = await parse("#1=IFCCOLUMN('0bbbbbbbbbbbbbbbbbbbbb',$,'Column B',$,$,$,$,$,.COLUMN.);");
    await loadModel('model-b', storeB, 1);

    const after = useViewerStore.getState();
    assert.equal(after.getModelOffset('model-b'), 0,
      'setup sanity: clearAllModels burned the registry back to offset 0');

    // The fix under test: global id 1 must NOT be red any more — it now
    // belongs to an IfcColumn the active lens rule does not match.
    assert.equal(
      after.lensColorMap.has(1), false,
      'lensColorMap must not keep coloring global id 1 red after the wall that ' +
      'earned that color is gone and a column now occupies the same id',
    );
    // A fresh evaluation legitimately puts id 1 back in `lensAppliedColors`
    // as a GHOST entry (alpha 0.15 — "loaded, unmatched"), which is correct:
    // what must NOT survive is the stale RED (matched) entry from wall A.
    const appliedEntry = after.lensAppliedColors?.get(1);
    assert.ok(
      appliedEntry === undefined || appliedEntry[3] < 0.2,
      'lensAppliedColors (what useCompareOverlay resends to the renderer verbatim) ' +
      `must not still carry wall A's opaque red match for global id 1 — got ${JSON.stringify(appliedEntry)}`,
    );
  });

  it('NEGATIVE CONTROL: an in-place model field patch does not thrash the evaluation', async () => {
    const store = await parse("#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);");
    await mountProbe();
    await loadModel('model-a', store, 1);
    await activateLens();

    const ref1 = useViewerStore.getState().lensColorMap;
    assert.equal(ref1.size, 1);

    // Same model id set — only a field on the existing model changes, the
    // way a visibility toggle or loading-progress patch does.
    await act(async () => {
      useViewerStore.getState().updateModel('model-a', { visible: false });
    });

    const ref2 = useViewerStore.getState().lensColorMap;
    assert.equal(ref2, ref1,
      'an in-place patch under the SAME model id set must not force a re-evaluation ' +
      '(the whole point of not subscribing to `models` directly) — this is the ' +
      'negative control proving the fix does not over-invalidate',
    );
  });
});
