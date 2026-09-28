/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opening a commit: what reaches the source-download bridge.
 *
 * The bridge is where the one load path in this app begins
 * (`ViewportContainer` → `useIfcLoader.loadFile`), so asserting on the
 * dispatched item is asserting on the whole contract between history and
 * loading — including the two things that are easy to get wrong and
 * invisible if they are: `replaceModelId` set only for Open (replace), and
 * the digest check that stops a service's wrong bytes being loaded under a
 * version's name.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureSourceProvider } from '@ifc-lite/source-fixture';
import type { FixtureWorldSpec } from '@ifc-lite/source-fixture';
import type { SourceCommit } from '@ifc-lite/plugin-api';

import { advance, cleanup, render } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import {
  SOURCE_DOWNLOAD_EVENT,
  type SourceDownloadEvent,
  type SourceDownloadItem,
} from '@/services/sources/source-host';
import { useViewerStore } from '@/store';
import type { CommitTag } from '@/store/slices/historySlice';
import { useCommitLoad } from './useCommitLoad';

const VIEWER_MODEL = 'viewer-model-1';
const REF = { projectId: 'proj-1', modelId: 'model-structural', commitId: 'c1' };

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
                fileName: 'structural-c1.ifc',
                content: 'COMMIT-1',
              },
              {
                id: 'c2',
                parents: ['c1'],
                createdAt: '2026-09-12T11:30:00.000Z',
                message: 'Coordination round 14',
                fileName: 'structural-c2.ifc',
                content: 'COMMIT-2',
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

/** Captures what `useCommitLoad` puts on the bridge. */
function captureDispatch(): { items: SourceDownloadItem[]; stop: () => void } {
  const items: SourceDownloadItem[] = [];
  const listener = (event: Event) => {
    items.push(...(event as SourceDownloadEvent).detail.items);
  };
  window.addEventListener(SOURCE_DOWNLOAD_EVENT, listener);
  return { items, stop: () => window.removeEventListener(SOURCE_DOWNLOAD_EVENT, listener) };
}

type Opener = ReturnType<typeof useCommitLoad>['openCommit'];

function mount(): { open: Opener; provider: ReturnType<typeof createFixtureSourceProvider> } {
  useViewerStore.setState({
    commitTags: new Map([[VIEWER_MODEL, commitTag()]]),
    sourceTags: new Map(),
  } as never);
  const provider = createFixtureSourceProvider({
    world: world(),
    capabilities: { commits: { payloadFormats: ['ifc-step'] } },
  });
  let captured: Opener | undefined;
  function Probe() {
    captured = useCommitLoad().openCommit;
    return null;
  }
  render(
    <SourceHostProvider additionalProviders={[() => provider]}>
      <Probe />
    </SourceHostProvider>,
  );
  assert.ok(captured, 'useCommitLoad provides openCommit');
  return { open: captured!, provider };
}

async function commitFrom(provider: ReturnType<typeof createFixtureSourceProvider>, commitId: string): Promise<SourceCommit> {
  const { createFixtureContext } = await import('@ifc-lite/source-fixture');
  return provider.getCommit!(createFixtureContext(), { ...REF, commitId });
}

describe('useCommitLoad.openCommit', () => {
  afterEach(cleanup);

  it('dispatches the commit bytes with a tag, and replaces in place for mode "replace"', async () => {
    const { open, provider } = mount();
    const commit = await commitFrom(provider, 'c1');
    const dispatch = captureDispatch();

    const ok = await open({ modelId: VIEWER_MODEL, ref: REF, commit, mode: 'replace', headCommitId: 'c2' });
    await advance(0);
    dispatch.stop();

    assert.equal(ok, true);
    assert.equal(dispatch.items.length, 1);
    const item = dispatch.items[0];
    assert.equal(item.name, 'structural-c1.ifc');
    assert.equal(new TextDecoder().decode(item.buffer), 'COMMIT-1');
    assert.equal(item.replaceModelId, VIEWER_MODEL);
    assert.equal(item.commit?.commitId, 'c1');
    // c1 is not the head (c2 is), so the model that lands is READ-ONLY.
    assert.equal(item.commit?.historical, true);
    assert.equal(item.commit?.artifactDigest, commit.artifact.digest);
  });

  it('federates rather than replaces for mode "alongside", under its own name', async () => {
    const { open, provider } = mount();
    const commit = await commitFrom(provider, 'c1');
    const dispatch = captureDispatch();

    await open({
      modelId: VIEWER_MODEL,
      ref: REF,
      commit,
      mode: 'alongside',
      headCommitId: 'c2',
      displayName: 'Structural model @ c1 · 3 Mar 2026',
    });
    await advance(0);
    dispatch.stop();

    const item = dispatch.items[0];
    assert.equal(item.replaceModelId, undefined, 'alongside must not remove the model it was opened from');
    // Three copies of `structural.ifc` in the model list are
    // indistinguishable; the label is what makes the federation readable.
    assert.equal(item.displayName, 'Structural model @ c1 · 3 Mar 2026');
  });

  it('marks the head as NOT historical, so it stays editable', async () => {
    const { open, provider } = mount();
    const commit = await commitFrom(provider, 'c2');
    const dispatch = captureDispatch();

    await open({
      modelId: VIEWER_MODEL,
      ref: { ...REF, commitId: 'c2' },
      commit,
      mode: 'replace',
      headCommitId: 'c2',
    });
    await advance(0);
    dispatch.stop();

    assert.equal(dispatch.items[0].commit?.historical, false);
  });

  it('refuses bytes whose digest is not the commit it claims to be', async () => {
    const { open, provider } = mount();
    const commit = await commitFrom(provider, 'c1');
    const dispatch = captureDispatch();

    // A service that served the WRONG commit's bytes would otherwise be
    // indistinguishable from one that served the right ones, and the user
    // would be looking at a model labelled as a version it is not.
    const ok = await open({
      modelId: VIEWER_MODEL,
      ref: REF,
      commit: { ...commit, artifact: { ...commit.artifact, digest: 'sha256:something-else' } },
      mode: 'replace',
      headCommitId: 'c2',
    });
    await advance(0);
    dispatch.stop();

    assert.equal(ok, false);
    assert.equal(dispatch.items.length, 0, 'nothing may reach the load path');
  });

  it('reports a provider failure rather than dispatching', async () => {
    const { open, provider } = mount();
    const commit = await commitFrom(provider, 'c1');
    provider.fixture.setFailure('loadCommit', { kind: 'throw', code: 'forbidden', message: 'no access', status: 403 });
    const dispatch = captureDispatch();

    const ok = await open({ modelId: VIEWER_MODEL, ref: REF, commit, mode: 'replace', headCommitId: 'c2' });
    await advance(0);
    dispatch.stop();

    assert.equal(ok, false);
    assert.equal(dispatch.items.length, 0);
  });
});
