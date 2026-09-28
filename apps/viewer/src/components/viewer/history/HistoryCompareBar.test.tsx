/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The compare strip: the STORED-diff preview, which is the half that needs
 * neither commit's bytes.
 *
 * That is the claim worth pinning — a coordinator asking "what changed
 * between these two" gets counts and a grouped list from one request, with no
 * model load at all. "Show in 3D" is the expensive half and stays a separate,
 * explicit click.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureSourceProvider } from '@ifc-lite/source-fixture';
import type { FixtureWorldSpec } from '@ifc-lite/source-fixture';

import { advance, cleanup, render } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { groupDiffEntries, PREVIEW_LIMIT, useCommitCompare } from '@/hooks/history/useCommitCompare';
import { useViewerStore } from '@/store';
import type { CommitTag } from '@/store/slices/historySlice';
import { HistoryCompareBar } from './HistoryCompareBar';
import type { SourceCommit, StoredDiffEntry } from '@ifc-lite/plugin-api';

const VIEWER_MODEL = 'viewer-model-1';
const REF = { projectId: 'proj-1', modelId: 'model-structural' };

function fingerprint(key: string, ifcType: string, dataHash: string) {
  return { key, ifcType, dataHash };
}

/** c2 modifies wall-a, adds door-a and deletes wall-b against c1. */
function world(): FixtureWorldSpec {
  return {
    projects: [
      {
        id: 'proj-1',
        name: 'Alpha',
        containers: [],
        files: [],
        models: [
          {
            id: 'model-structural',
            name: 'Structural model',
            commits: [
              {
                id: 'c1',
                parents: [],
                createdAt: '2026-03-03T08:00:00.000Z',
                message: 'Initial delivery',
                fileName: 'c1.ifc',
                content: 'C1',
                fingerprints: [
                  fingerprint('wall-a', 'IfcWall', 'd1'),
                  fingerprint('wall-b', 'IfcWall', 'd2'),
                ],
              },
              {
                id: 'c2',
                parents: ['c1'],
                createdAt: '2026-09-12T11:30:00.000Z',
                message: 'Coordination round 14',
                fileName: 'c2.ifc',
                content: 'C2',
                fingerprints: [
                  fingerprint('wall-a', 'IfcWall', 'd1-edited'),
                  fingerprint('door-a', 'IfcDoor', 'd3'),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function commitTag(): CommitTag {
  return {
    provider: 'fixture',
    projectId: 'proj-1',
    sourceModelId: 'model-structural',
    commitId: 'c2',
    artifactDigest: 'sha256:x',
    historical: false,
    loadedAt: 1,
  };
}

function commit(id: string, createdAt: string, message: string): SourceCommit {
  return {
    id,
    modelId: 'model-structural',
    projectId: 'proj-1',
    parents: id === 'c2' ? ['c1'] : [],
    createdAt,
    status: 'published',
    message,
    artifact: { digest: `sha256:${id}`, fileName: `${id}.ifc`, sizeBytes: 2 },
  };
}

const C1 = commit('c1', '2026-03-03T08:00:00.000Z', 'Initial delivery');
const C2 = commit('c2', '2026-09-12T11:30:00.000Z', 'Coordination round 14');

/** Mounts the bar with the hook wired to the fixture provider, as the panel does. */
function Harness({ storedDiffs = true }: { storedDiffs?: boolean }) {
  const compare = useCommitCompare(
    VIEWER_MODEL,
    { ...REF, commitId: 'c1' },
    { ...REF, commitId: 'c2' },
  );
  void storedDiffs;
  return (
    <HistoryCompareBar
      a={C1}
      b={C2}
      compare={compare}
      onClearSlot={() => {}}
      onShowIn3D={() => {}}
      showing3D={false}
    />
  );
}

function mount(capabilities?: Parameters<typeof createFixtureSourceProvider>[0]['capabilities']) {
  useViewerStore.setState({
    commitTags: new Map([[VIEWER_MODEL, commitTag()]]),
    sourceTags: new Map(),
  } as never);
  const provider = createFixtureSourceProvider({
    world: world(),
    ...(capabilities ? { capabilities } : {}),
  });
  const container = render(
    <SourceHostProvider additionalProviders={[() => provider]}>
      <Harness />
    </SourceHostProvider>,
  );
  return { container, provider };
}

describe('groupDiffEntries', () => {
  const entry = (state: StoredDiffEntry['state'], ifcType: string, key: string): StoredDiffEntry =>
    ({ key, ifcType, state, changeKinds: state === 'modified' ? ['data'] : [] });

  it('groups by state then IFC type, added before modified before deleted', () => {
    const groups = groupDiffEntries([
      entry('deleted', 'IfcWall', 'w1'),
      entry('added', 'IfcDoor', 'd1'),
      entry('modified', 'IfcWall', 'w2'),
      entry('added', 'IfcDoor', 'd2'),
    ]);
    assert.deepEqual(
      groups.map((g) => `${g.state}:${g.ifcType}:${g.entries.length}`),
      ['added:IfcDoor:2', 'modified:IfcWall:1', 'deleted:IfcWall:1'],
    );
  });

  it('stops at the preview limit so a 10,000-change diff still renders', () => {
    const many = Array.from({ length: PREVIEW_LIMIT + 50 }, (_, i) => entry('added', 'IfcWall', `w${i}`));
    const total = groupDiffEntries(many).reduce((sum, g) => sum + g.entries.length, 0);
    assert.equal(total, PREVIEW_LIMIT);
  });
});

describe('HistoryCompareBar', () => {
  afterEach(cleanup);

  it('renders the counts and the grouped types from the stored diff', async () => {
    const { container } = mount();
    await advance(0);

    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    // 1 added (door-a), 1 modified (wall-a), 1 deleted (wall-b).
    assert.match(text, /1 added · 1 modified · 1 deleted/);
    assert.match(text, /IfcDoor/);
    assert.match(text, /IfcWall/);
  });

  it('does not load either model to produce the preview', async () => {
    const { container, provider } = mount();
    // `loadCommit` is the expensive call. Made to throw: if the preview
    // needed it, the counts below would never appear.
    provider.fixture.setFailure('loadCommit', { kind: 'throw', message: 'bytes were fetched' });
    await advance(0);
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    assert.match(text, /1 added/);
    assert.ok(!/bytes were fetched/.test(text));
  });

  it('says so when the source cannot pre-compute changes', async () => {
    const { container } = mount({
      commits: { payloadFormats: ['ifc-step'], storedDiffs: false },
    });
    await advance(0);
    assert.match(
      container.textContent ?? '',
      /This source cannot pre-compute changes; open both versions to compare them/,
    );
  });
});
