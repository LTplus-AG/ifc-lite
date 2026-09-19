/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's Suggestions section and sidecar round-trip (issue
 * #4955), mounted with a seeded store (AGENTS.md "Testing a viewer
 * component"). The comparison result is seeded directly — the wasm pipeline
 * is not under test here — and every assertion is on what the user sees or
 * on what lands in the store, never on wiring.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act } from 'react';
import {
  createIdentityMapSidecar,
  parseIdentityMapSidecar,
  serializeIdentityMapSidecar,
  type DiffEntry,
  type EntityFingerprint,
  type ModelDiff,
  type SplitMergeClaim,
  type SuccessorClaim,
} from '@ifc-lite/diff';
import { render, click, advance, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import type { CompareResult } from '@/store/slices/compareSlice';
import type { CompareRef } from '@/lib/compare/buildFingerprints';
import { ComparePanel } from '../ComparePanel.js';

const HEAD_OFFSET = 1_000_000;
const A_BYTES = 'ISO-10303-21; version A';
const B_BYTES = 'ISO-10303-21; version B';

function fp(modelId: 'A' | 'B', localId: number, key: string, ifcType = 'IfcWall'): EntityFingerprint<CompareRef> {
  const globalId = modelId === 'A' ? localId : localId + HEAD_OFFSET;
  return { key, ifcType, dataHash: `d:${key}`, ref: { modelId, localId, globalId } };
}

const oldWall = fp('A', 1, 'W1');
const newWall = fp('B', 2, 'W1b');
const whole = fp('A', 3, 'W2');
const pieces = [fp('B', 4, 'P1'), fp('B', 5, 'P2'), fp('B', 6, 'P3')];
/** Deleted with nothing carrying it forward: what a rekey must orphan. */
const goneWall = fp('A', 7, 'W9');
const AB = { baseModelId: 'A', headModelId: 'B' };

const successorClaim: SuccessorClaim<CompareRef> = {
  confidence: 'footprint',
  base: oldWall,
  head: newWall,
  overlap: 0.81,
  distance: 0.02,
  agreeingComponents: ['pset:Pset_WallCommon'],
};

const splitClaim: SplitMergeClaim<CompareRef> = {
  kind: 'split',
  confidence: 'verified',
  whole,
  pieces,
  wholeVolume: 10,
  piecesVolume: 9.88,
  volumeResidual: -0.012,
};

function entry(state: 'added' | 'deleted', f: EntityFingerprint<CompareRef>): DiffEntry<CompareRef> {
  return state === 'added'
    ? { key: f.key, state, changeKinds: [], head: f }
    : { key: f.key, state, changeKinds: [], base: f };
}

function seededResult(over: Partial<ModelDiff<CompareRef>> = {}): CompareResult {
  const entries = [entry('deleted', oldWall), entry('added', newWall), entry('deleted', whole), ...pieces.map((p) => entry('added', p)), entry('deleted', goneWall)];
  const diff: ModelDiff<CompareRef> = {
    entries,
    byKey: new Map(entries.map((e) => [e.key, e])),
    counts: { added: 4, modified: 0, deleted: 3, unchanged: 0 },
    scope: 'both',
    excludedTypes: [],
    contentMatches: [],
    successors: [successorClaim],
    splitMerges: [splitClaim],
    ...over,
  };
  return {
    baseModelId: 'A',
    headModelId: 'B',
    baseName: 'A.ifc',
    headName: 'B.ifc',
    scope: 'both',
    geometryUnavailable: false,
    excludedHiddenIds: new Set(),
    diff,
  };
}

function seed(): void {
  const a = fixtureModel('A', {
    entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall old' }, { expressId: 3, type: 'IfcWall', name: 'Long wall' }, { expressId: 7, type: 'IfcWall', name: 'Gone wall' }],
  });
  const b = fixtureModel('B', {
    idOffset: HEAD_OFFSET,
    entities: [{ expressId: 2, type: 'IfcWall', name: 'Wall new' }, ...[4, 5, 6].map((id) => ({ expressId: id, type: 'IfcWall', name: `Piece ${id}` }))],
  });
  Object.assign(a, { sourceFile: new File([A_BYTES], 'A.ifc') });
  Object.assign(b, { sourceFile: new File([B_BYTES], 'B.ifc') });
  useViewerStore.setState({
    ...fixtureModels(a, b),
    compareBaseModelId: 'A',
    compareHeadModelId: 'B',
    compareResult: seededResult(),
    compareAcceptedIdentity: [],
    compareRejectedClaims: [],
    compareSelectedKey: null,
    compareError: null,
  });
}

const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function buttons(container: HTMLElement, text: string): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text) as HTMLButtonElement[];
}

/** Capture what `downloadBlob` would have saved. */
function captureDownloads(): { downloads: Array<{ name: string; blob: Blob }>; restore: () => void } {
  const downloads: Array<{ name: string; blob: Blob }> = [];
  const originalCreate = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  let pending: Blob | null = null;
  (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = (blob: Blob) => {
    pending = blob;
    return 'blob:compare-sidecar';
  };
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (this.download && pending) downloads.push({ name: this.download, blob: pending });
  };
  return {
    downloads,
    restore: () => {
      (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
    },
  };
}

/**
 * Wait until `count` downloads were captured. The sidecar export digests the
 * two models' bytes with `crypto.subtle` before it saves, so a fixed wait races
 * a loaded CI runner: the first test then sees 0 saves and the next one sees 2.
 */
async function waitForDownloads(
  capture: ReturnType<typeof captureDownloads>,
  count: number,
  label = 'download',
): Promise<void> {
  for (let i = 0; i < 250 && capture.downloads.length < count; i++) await advance(20);
  assert.equal(capture.downloads.length, count, `${count} ${label}(s) saved`);
}

/** Poll until `ready()` holds — the import path digests the file bytes first. */
async function waitUntil(ready: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 250 && !ready(); i++) await advance(20);
  assert.ok(ready(), label);
}

/** Hand a file to the hidden import input the way the picker does. */
function importFile(container: HTMLElement, file: File): void {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  assert.ok(input, 'the import input must be rendered');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

beforeEach(seed);
afterEach(cleanup);

describe('ComparePanel Suggestions (#4955)', () => {
  it('lists a successor claim and a split claim, each with its evidence line', () => {
    const container = render(<ComparePanel />);
    const text = container.textContent ?? '';
    assert.ok(text.includes('Suggestions'), 'section header');
    assert.ok(text.includes('Wall new'), 'the successor row is named after the head entity');
    assert.ok(text.includes('Replaced · footprint 0.81 · 0.02 m · agrees on Pset_WallCommon'), text);
    assert.ok(text.includes('Long wall'), 'the split row is named after the whole');
    assert.ok(text.includes('Split into 3 · verified · Δvol −1.2%'), text);
    // Only the successor can be accepted: identity does not survive a split.
    assert.equal(buttons(container, 'Accept').length, 1);
    assert.equal(buttons(container, 'Not the same').length, 1);
  });

  it('Accept writes { base, here, reason: successor:<confidence> } to the store and the row is gone', () => {
    const container = render(<ComparePanel />);
    click(buttons(container, 'Accept')[0]);
    assert.deepEqual(useViewerStore.getState().compareAcceptedIdentity, [
      { ...AB, base: 'W1', here: 'W1b', reason: 'successor:footprint' },
    ]);
    const text = container.textContent ?? '';
    assert.ok(!text.includes('Replaced ·'), 'the accepted successor is no longer offered');
    assert.ok(text.includes('Split into 3'), 'the split claim is unaffected');
    assert.equal(buttons(container, 'Accept').length, 0);
  });

  it('Not the same hides the row and records the rejection so it is not re-offered', () => {
    const container = render(<ComparePanel />);
    click(buttons(container, 'Not the same')[0]);
    assert.deepEqual(useViewerStore.getState().compareRejectedClaims, [{ ...AB, base: 'W1', here: 'W1b' }]);
    assert.deepEqual(useViewerStore.getState().compareAcceptedIdentity, []);
    assert.ok(!(container.textContent ?? '').includes('Replaced ·'));
    // Re-mounting over the same result must not bring it back.
    cleanup();
    const again = render(<ComparePanel />);
    assert.ok(!(again.textContent ?? '').includes('Replaced ·'));
  });

  it('clicking a suggestion row selects its entities in 3D', () => {
    const container = render(<ComparePanel />);
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Split into 3'));
    assert.ok(row);
    click(row);
    const selected = useViewerStore.getState().selectedEntityIds;
    // The whole (A) and every piece (B, offset ids).
    assert.deepEqual([...selected].sort((x, y) => x - y), [3, 4 + HEAD_OFFSET, 5 + HEAD_OFFSET, 6 + HEAD_OFFSET]);
  });

  it('exports an identity-map sidecar pinned to the file bytes whose entries equal the accepted list', async () => {
    const capture = captureDownloads();
    try {
      const container = render(<ComparePanel />);
      click(buttons(container, 'Accept')[0]);
      click(buttons(container, 'Export map')[0]);
      await waitForDownloads(capture, 1, 'identity map');
      assert.equal(capture.downloads[0].name, 'compare-A.ifc-vs-B.ifc.identity-map.json');
      const sidecar = parseIdentityMapSidecar(await capture.downloads[0].blob.text());
      assert.deepEqual(sidecar.entries, [{ base: 'W1', here: 'W1b', reason: 'successor:footprint' }]);
      assert.equal(sidecar.base.hash, sha(A_BYTES));
      assert.equal(sidecar.head.hash, sha(B_BYTES));
    } finally {
      capture.restore();
    }
  });

  interface LineageFile {
    format: string;
    deleted: string[];
    entries: Array<{ relation: string; base: string[]; head: string[]; reason: string }>;
  }

  async function exportLineage(container: HTMLElement, capture: ReturnType<typeof captureDownloads>): Promise<LineageFile> {
    click(buttons(container, 'Export lineage')[0]);
    await waitForDownloads(capture, 1, 'lineage');
    return JSON.parse(await capture.downloads[0].blob.text()) as LineageFile;
  }

  const relationsOf = (lineage: LineageFile) =>
    lineage.entries.map((e) => `${e.relation}:${e.base.join('+')}>${e.head.join('+')}:${e.reason}`).sort();

  it('exports a lineage sidecar carrying the split, the accepted replacement and the orphaned deletes', async () => {
    const capture = captureDownloads();
    try {
      const container = render(<ComparePanel />);
      click(buttons(container, 'Accept')[0]);
      const lineage = await exportLineage(container, capture);
      assert.equal(lineage.format, 'ifc-lite/lineage');
      assert.deepEqual(relationsOf(lineage), [
        'replaced:W1>W1b:successor:footprint',
        'split:W2>P1+P2+P3:split:verified',
      ]);
      // W1 is replaced and W2 split; only W9 has nowhere to go (review find 2).
      assert.deepEqual(lineage.deleted, ['W9']);
    } finally {
      capture.restore();
    }
  });

  it('exports the accepted replacement as `replaced` after the re-diff has aliased it (review find 3)', async () => {
    // After Accept, useCompare re-diffs with the pair as a key alias: the
    // claim is gone from `successors` and the engine reports it under
    // `appliedKeyAliases`. The lineage must still say what the user said.
    const aliased = [entry('deleted', whole), ...pieces.map((p) => entry('added', p)), entry('deleted', goneWall)];
    useViewerStore.setState({
      compareResult: seededResult({
        entries: aliased,
        byKey: new Map(aliased.map((e) => [e.key, e])),
        counts: { added: 3, modified: 0, deleted: 2, unchanged: 1 },
        successors: [],
        appliedKeyAliases: new Map([['W1b', 'W1']]),
      }),
      compareAcceptedIdentity: [{ ...AB, base: 'W1', here: 'W1b', reason: 'successor:footprint' }],
    });
    const capture = captureDownloads();
    try {
      const container = render(<ComparePanel />);
      const lineage = await exportLineage(container, capture);
      assert.deepEqual(relationsOf(lineage), [
        'replaced:W1>W1b:successor:footprint',
        'split:W2>P1+P2+P3:split:verified',
      ]);
      assert.deepEqual(lineage.deleted, ['W9']);
    } finally {
      capture.restore();
    }
  });

  it('exports only the decisions made for THIS model pair (review find 5)', async () => {
    useViewerStore.setState({
      compareAcceptedIdentity: [{ baseModelId: 'A', headModelId: 'C', base: 'W1', here: 'W1b', reason: 'successor:footprint' }],
    });
    const capture = captureDownloads();
    try {
      const container = render(<ComparePanel />);
      assert.ok((container.textContent ?? '').includes('Replaced ·'), 'another pair\'s decision does not hide the suggestion');
      click(buttons(container, 'Export map')[0]);
      await waitForDownloads(capture, 1, 'identity map');
      const sidecar = parseIdentityMapSidecar(await capture.downloads[0].blob.text());
      assert.deepEqual(sidecar.entries, []);
    } finally {
      capture.restore();
    }
  });

  it('refuses an identity-map sidecar written for other model bytes, visibly', async () => {
    const container = render(<ComparePanel />);
    const foreign = createIdentityMapSidecar({
      base: { hash: sha('some other A') },
      head: { hash: sha(B_BYTES) },
      entries: [{ base: 'W1', here: 'W1b', reason: 'successor:footprint' }],
    });
    importFile(container, new File([serializeIdentityMapSidecar(foreign)], 'foreign.identity-map.json'));
    await waitUntil(() => container.querySelector('[role="status"]') !== null, 'a status message appears');
    const status = container.querySelector('[role="status"]');
    assert.ok(status, 'a refusal message is shown');
    assert.match(status.textContent ?? '', /base model does not match/);
    assert.deepEqual(useViewerStore.getState().compareAcceptedIdentity, [], 'nothing was imported');
  });

  it('imports a matching identity-map sidecar into the accepted list and drops the matching suggestion', async () => {
    const container = render(<ComparePanel />);
    const own = createIdentityMapSidecar({
      base: { hash: sha(A_BYTES) },
      head: { hash: sha(B_BYTES) },
      entries: [{ base: 'W1', here: 'W1b', reason: 'successor:footprint' }],
    });
    importFile(container, new File([serializeIdentityMapSidecar(own)], 'own.identity-map.json'));
    await waitUntil(() => useViewerStore.getState().compareAcceptedIdentity.length > 0, 'the import landed in the store');
    assert.deepEqual(useViewerStore.getState().compareAcceptedIdentity, [
      { ...AB, base: 'W1', here: 'W1b', reason: 'successor:footprint' },
    ]);
    assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /Imported 1 identity entr/);
    assert.ok(!(container.textContent ?? '').includes('Replaced ·'));
  });
});
