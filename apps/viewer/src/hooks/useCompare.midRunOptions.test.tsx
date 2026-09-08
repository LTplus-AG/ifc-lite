/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mid-run option changes in `useCompare` (#1891 review, Greptile P1 + Codex P2).
 *
 * `runComparison` is async: it yields a frame so "Comparing…" paints, then
 * awaits fingerprint extraction (which itself yields every 1500 entities). The
 * scope / blacklist / content-matching controls stay live for that whole
 * window. Reading the options BEFORE those awaits and publishing a result built
 * from the captured values silently loses any change made in between - and the
 * reconciliation effect cannot catch it, because it deliberately omits `result`
 * from its deps: the option change already fired the effect (against a null or
 * older result) and the stale result landing afterwards re-runs nothing.
 *
 * The user-visible symptom is the whole panel disagreeing with its own
 * checkbox - counts, rows, overlay and exported CSV - until some other option
 * moves or the comparison is re-run. So these tests assert the published
 * COUNTS, not just a flag: with matching off the re-GUIDed wall is 1 added +
 * 1 deleted, with it on it is 0/0 plus one content match.
 *
 * The fixture is two real parsed models holding the same wall under different
 * GlobalIds - the from-scratch re-export the content pass exists for.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { DiffScope } from '@ifc-lite/diff';
import { useViewerStore, type FederatedModel } from '@/store';
import { useCompare } from './useCompare.js';

// ─── Fixture: one wall, re-GUIDed between A and B ────────────────────────

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

/** A wall plus its property set, all IfcRoot GlobalIds swapped per revision -
 *  identical content, no shared key, which is exactly what the content pass is
 *  meant to re-pair. */
function wall(guid: string, psetGuid: string, relGuid: string): string {
  return [
    `#1=IFCWALL('${guid}',$,'Wall A',$,$,$,$,$,.STANDARD.);`,
    `#2=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('60'),$);`,
    `#3=IFCPROPERTYSET('${psetGuid}',$,'Pset_WallCommon',$,(#2));`,
    `#4=IFCRELDEFINESBYPROPERTIES('${relGuid}',$,$,$,(#1),#3);`,
  ].join('\n');
}

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  // disableWorkerScan keeps the scan in-process (no Worker under node:test).
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

function model(id: string, store: IfcDataStore, idOffset: number): FederatedModel {
  // `buildEntityFingerprints` reads only the express id and the geometry hash
  // off a mesh. Both sides carry the SAME hash, so the shapes agree and the
  // content pass resolves the pair rather than handing it back for review.
  const meshes = [{ expressId: 1 + idOffset, geometryHash: 42n } as unknown as MeshData];
  return {
    id,
    name: id,
    ifcDataStore: store,
    geometryResult: { meshes } as unknown as GeometryResult,
    idOffset,
    maxExpressId: 4,
  } as unknown as FederatedModel;
}

// ─── Harness ────────────────────────────────────────────────────────────

let runComparison: (() => Promise<void>) | null = null;

function Probe(): null {
  runComparison = useCompare().runComparison;
  return null;
}

let root: Root | null = null;

async function seed(): Promise<void> {
  const [a, b] = await Promise.all([
    parse(wall('0aaaaaaaaaaaaaaaaaaaaa', '0bbbbbbbbbbbbbbbbbbbbb', '0ccccccccccccccccccccc')),
    parse(wall('1zzzzzzzzzzzzzzzzzzzzz', '1yyyyyyyyyyyyyyyyyyyyy', '1xxxxxxxxxxxxxxxxxxxxx')),
  ]);
  useViewerStore.setState({
    models: new Map([
      ['A', model('A', a, 0)],
      ['B', model('B', b, 1000)],
    ]),
    compareBaseModelId: 'A',
    compareHeadModelId: 'B',
    compareScope: 'both',
    compareExcludedTypes: [],
    compareResult: null,
    compareError: null,
    compareRunning: false,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
}

/**
 * Start a comparison, change an option while it is still in flight, then let it
 * finish.
 *
 * The start and the mutation use the SYNCHRONOUS `act` deliberately: the run's
 * first `await` is a `setTimeout(0)` macrotask, and the async form of `act`
 * yields far enough for that timer to fire, which lets the whole run complete
 * before the mutation and quietly turns the test into a no-op. With no `await`
 * anywhere between `runComparison()` and `mutate()`, the interleaving the bug
 * needs is guaranteed rather than raced for. The in-flight assertion below is
 * the belt-and-braces check on exactly that (it is what caught the async
 * version being flaky).
 */
async function runWithMidRunChange(mutate: () => void): Promise<void> {
  let pending: Promise<void> | undefined;
  act(() => {
    pending = runComparison!();
  });
  assert.ok(pending, 'runComparison must have started');
  assert.strictEqual(useViewerStore.getState().compareResult, null, 'run must still be in flight');
  act(() => {
    mutate();
  });
  await act(async () => {
    await pending;
  });
}

function published() {
  const result = useViewerStore.getState().compareResult;
  assert.ok(result, 'the comparison must have published a result');
  return result;
}

beforeEach(async () => {
  runComparison = null;
  await seed();
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

describe('useCompare - an option changed mid-run wins (#1891 review)', () => {
  it('publishes with content matching OFF when it was switched off during the run', async () => {
    useViewerStore.setState({ compareMatchByContent: true });
    await runWithMidRunChange(() => {
      useViewerStore.getState().setCompareMatchByContent(false);
    });

    const result = published();
    // Pre-fix this was the flag captured before the fingerprint yield (`true`),
    // so the panel showed 0 added / 0 deleted / 1 match under an UNCHECKED box.
    assert.strictEqual(result.diff.contentMatches, undefined, 'the pass must not have run');
    assert.strictEqual(result.diff.counts.added, 1);
    assert.strictEqual(result.diff.counts.deleted, 1);
  });

  it('publishes with content matching ON when it was switched on during the run', async () => {
    useViewerStore.setState({ compareMatchByContent: false });
    await runWithMidRunChange(() => {
      useViewerStore.getState().setCompareMatchByContent(true);
    });

    const result = published();
    assert.ok(result.diff.contentMatches, 'the pass must have run');
    assert.strictEqual(result.diff.contentMatches.length, 1);
    assert.strictEqual(result.diff.counts.added, 0);
    assert.strictEqual(result.diff.counts.deleted, 0);
  });

  it('publishes the scope chosen during the run, not the one the run started with', async () => {
    // The same hole, latent since #924: the scope buttons are not disabled
    // while a comparison is running either. The publish-time read closes all
    // three options at once, so this is the regression guard for the two the
    // content checkbox merely got to first.
    useViewerStore.setState({ compareMatchByContent: true });
    await runWithMidRunChange(() => {
      useViewerStore.getState().setCompareScope('data' satisfies DiffScope);
    });

    assert.strictEqual(published().scope, 'data');
  });

  it('publishes the blacklist chosen during the run, so the excluded class is gone', async () => {
    useViewerStore.setState({ compareMatchByContent: false });
    await runWithMidRunChange(() => {
      useViewerStore.getState().addCompareExcludedType('IfcWall');
    });

    const result = published();
    assert.deepStrictEqual(result.diff.excludedTypes, ['IFCWALL']);
    // The only element in the fixture is the wall, so excluding it must empty
    // the diff - not merely record the class on a result that still lists it.
    assert.strictEqual(result.diff.counts.added, 0);
    assert.strictEqual(result.diff.counts.deleted, 0);
    assert.strictEqual(result.diff.entries.length, 0);
  });

  it('leaves the reconciliation effect a no-op, so publishing does not re-diff', async () => {
    // Rejects the other candidate fix: publish the stale result anyway and add
    // `result` to the effect's deps so the effect cleans it up afterwards. That
    // converges too, so tests 1-4 cannot tell the two apart - but it does so by
    // paying a second full diff and showing one wrong frame in between, and it
    // arms exactly the setCompareResult -> re-render -> re-diff cycle the
    // missing dep exists to prevent. `compareRunSeq` counts completed diffs, so
    // 2 here means the stale result was published and then patched. Verified by
    // mutation: this assertion reads 2 under that alternative.
    useViewerStore.setState({ compareMatchByContent: true, compareRunSeq: 0 });
    await runWithMidRunChange(() => {
      useViewerStore.getState().setCompareMatchByContent(false);
    });

    assert.strictEqual(useViewerStore.getState().compareRunSeq, 1);
  });

  it('still reconciles a change made AFTER the result landed', async () => {
    // The stale-publish fix must not cost the existing instant re-diff.
    useViewerStore.setState({ compareMatchByContent: true });
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = runComparison!();
    });
    await act(async () => {
      await pending;
    });
    assert.ok(published().diff.contentMatches, 'baseline: the pass ran');

    await act(async () => {
      useViewerStore.getState().setCompareMatchByContent(false);
    });
    const result = published();
    assert.strictEqual(result.diff.contentMatches, undefined);
    assert.strictEqual(result.diff.counts.added, 1);
    assert.strictEqual(result.diff.counts.deleted, 1);
  });
});
