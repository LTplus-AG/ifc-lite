/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writing an accepted content match back to the commit service.
 *
 * Three refusals are as important as the one write: two commits of DIFFERENT
 * models are not what `recordIdentity` records, a provider without write
 * access must keep the decision local (exactly as before commit sources
 * existed), and a failed write must not throw into the accept handler that
 * has already recorded the decision locally.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureContext, createFixtureSourceProvider } from '@ifc-lite/source-fixture';
import type { FixtureWorldSpec } from '@ifc-lite/source-fixture';

import { advance, cleanup, render } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { useViewerStore } from '@/store';
import type { CommitTag } from '@/store/slices/historySlice';
import { useRecordCommitIdentity } from './useRecordCommitIdentity';

const BASE_MODEL = 'viewer-base';
const HEAD_MODEL = 'viewer-head';

function world(): FixtureWorldSpec {
  const commits = (prefix: string) => [
    {
      id: `${prefix}1`,
      parents: [] as string[],
      createdAt: '2026-03-03T08:00:00.000Z',
      fileName: `${prefix}1.ifc`,
      content: `${prefix}1`,
      fingerprints: [{ key: 'wall-a', ifcType: 'IfcWall', dataHash: 'd1' }],
    },
    {
      id: `${prefix}2`,
      parents: [`${prefix}1`],
      createdAt: '2026-09-12T11:30:00.000Z',
      fileName: `${prefix}2.ifc`,
      content: `${prefix}2`,
      fingerprints: [{ key: 'wall-a2', ifcType: 'IfcWall', dataHash: 'd1' }],
    },
  ];
  return {
    projects: [
      {
        id: 'proj-1',
        name: 'Alpha',
        containers: [],
        files: [],
        models: [
          { id: 'model-a', name: 'Model A', commits: commits('a') },
          { id: 'model-b', name: 'Model B', commits: commits('b') },
        ],
      },
    ],
  };
}

function tag(sourceModelId: string, commitId: string): CommitTag {
  return {
    provider: 'fixture',
    projectId: 'proj-1',
    sourceModelId,
    commitId,
    artifactDigest: 'sha256:x',
    historical: commitId.endsWith('1'),
    loadedAt: 1,
  };
}

type Recorder = ReturnType<typeof useRecordCommitIdentity>;

function mount(options: {
  readonly baseTag: CommitTag | null;
  readonly headTag: CommitTag;
  readonly write?: boolean;
}) {
  useViewerStore.setState({
    commitTags: new Map(
      [...(options.baseTag ? [[BASE_MODEL, options.baseTag] as const] : []), [HEAD_MODEL, options.headTag] as const],
    ),
    sourceTags: new Map(),
  } as never);

  const provider = createFixtureSourceProvider({
    world: world(),
    capabilities: { commits: { payloadFormats: ['ifc-step'], write: options.write ?? true } },
  });
  let record: Recorder | undefined;
  function Probe() {
    record = useRecordCommitIdentity();
    return null;
  }
  render(
    <SourceHostProvider additionalProviders={[() => provider]}>
      <Probe />
    </SourceHostProvider>,
  );
  assert.ok(record);
  return { record: record!, provider };
}

const ENTRY = { base: 'wall-a', here: 'wall-a2', reason: 'content-match:renamed' };

async function recordedOn(provider: ReturnType<typeof createFixtureSourceProvider>, modelId: string) {
  const ctx = createFixtureContext();
  const records = await provider.listIdentityRecords!(
    ctx,
    { projectId: 'proj-1', modelId, commitId: `${modelId === 'model-a' ? 'a' : 'b'}1` },
    { projectId: 'proj-1', modelId, commitId: `${modelId === 'model-a' ? 'a' : 'b'}2` },
  );
  return records.entries;
}

describe('useRecordCommitIdentity', () => {
  afterEach(cleanup);

  it('persists an accepted pair against the two commits', async () => {
    const { record, provider } = mount({ baseTag: tag('model-a', 'a1'), headTag: tag('model-a', 'a2') });
    record(BASE_MODEL, HEAD_MODEL, [ENTRY]);
    await advance(0);

    const entries = await recordedOn(provider, 'model-a');
    assert.deepEqual(entries.map((e) => `${e.base}->${e.here}`), ['wall-a->wall-a2']);
  });

  it('writes nothing when the provider cannot', async () => {
    const { record, provider } = mount({
      baseTag: tag('model-a', 'a1'),
      headTag: tag('model-a', 'a2'),
      write: false,
    });
    record(BASE_MODEL, HEAD_MODEL, [ENTRY]);
    await advance(0);
    assert.equal(provider.recordIdentity, undefined, 'the method is absent when write is false');
    assert.deepEqual(await recordedOn(provider, 'model-a'), []);
  });

  it('writes nothing for two commits of DIFFERENT models', async () => {
    const { record, provider } = mount({ baseTag: tag('model-a', 'a1'), headTag: tag('model-b', 'b2') });
    record(BASE_MODEL, HEAD_MODEL, [ENTRY]);
    await advance(0);
    // Identity across two models is not what `recordIdentity` records; a
    // service asked to store one would be right to refuse.
    assert.deepEqual(await recordedOn(provider, 'model-b'), []);
  });

  it('writes nothing when one side is not a commit at all', async () => {
    const { record, provider } = mount({ baseTag: null, headTag: tag('model-a', 'a2') });
    record(BASE_MODEL, HEAD_MODEL, [ENTRY]);
    await advance(0);
    assert.deepEqual(await recordedOn(provider, 'model-a'), []);
  });

  it('swallows a provider failure — the local decision is already made', async () => {
    const { record, provider } = mount({ baseTag: tag('model-a', 'a1'), headTag: tag('model-a', 'a2') });
    provider.fixture.setFailure('recordIdentity', { kind: 'throw', message: 'service down' });
    // No rejection reaches the caller: `accept` has already recorded the pair
    // locally, and undoing that because a write failed would be worse.
    assert.doesNotThrow(() => record(BASE_MODEL, HEAD_MODEL, [ENTRY]));
    await advance(0);
  });
});
