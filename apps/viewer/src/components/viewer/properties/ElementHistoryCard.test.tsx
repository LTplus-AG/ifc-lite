/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The element-history card, driven through the real fixture provider.
 *
 * The behaviour worth pinning is not "it renders a list": it is that the card
 * is LAZY (the properties panel re-renders on every selection, and a request
 * per click would be a round trip for every element a user passes through),
 * and that a re-GUID reads as one life rather than as a death and a birth.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureSourceProvider } from '@ifc-lite/source-fixture';
import type { FixtureWorldSpec } from '@ifc-lite/source-fixture';

import { advance, cleanup, click, render } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { useViewerStore } from '@/store';
import type { CommitTag } from '@/store/slices/historySlice';
import { ElementHistoryCard } from './ElementHistoryCard';

const VIEWER_MODEL = 'viewer-model-1';

function fingerprint(key: string, dataHash: string) {
  return { key, ifcType: 'IfcWall', dataHash, components: { 'attr:core': dataHash } };
}

/** wall-a is re-GUIDed to wall-a2 in c2, then edited in c3. */
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
                fingerprints: [fingerprint('wall-a', 'd1')],
              },
              {
                id: 'c2',
                parents: ['c1'],
                createdAt: '2026-09-12T11:30:00.000Z',
                message: 'Coordination round 14',
                fileName: 'c2.ifc',
                content: 'C2',
                identity: [{ base: 'wall-a', here: 'wall-a2', reason: 'content-match:renamed' }],
                fingerprints: [fingerprint('wall-a2', 'd1')],
              },
              {
                id: 'c3',
                parents: ['c2'],
                createdAt: '2026-09-25T09:15:00.000Z',
                message: 'Update slab openings',
                fileName: 'c3.ifc',
                content: 'C3',
                fingerprints: [fingerprint('wall-a2', 'd2')],
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
    commitId: 'c3',
    artifactDigest: 'sha256:x',
    historical: false,
    loadedAt: 1,
  };
}

function mount(options: { tagged: boolean; capabilities?: Parameters<typeof createFixtureSourceProvider>[0]['capabilities'] }) {
  useViewerStore.setState({
    commitTags: options.tagged ? new Map([[VIEWER_MODEL, commitTag()]]) : new Map(),
    sourceTags: new Map(),
  } as never);
  const provider = createFixtureSourceProvider({
    world: world(),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });
  const container = render(
    <SourceHostProvider additionalProviders={[() => provider]}>
      <ElementHistoryCard modelId={VIEWER_MODEL} elementKey="wall-a2" />
    </SourceHostProvider>,
  );
  return { container, provider };
}

function toggle(container: HTMLElement): void {
  const button = container.querySelector('button[aria-expanded]');
  assert.ok(button, 'the card header must be an expandable button');
  click(button!);
}

describe('ElementHistoryCard', () => {
  afterEach(cleanup);

  it('renders nothing for a model with no commit tag', () => {
    const { container } = mount({ tagged: false });
    assert.equal(
      container.textContent,
      '',
      'an always-present "not available" card is noise on every selection in every local file',
    );
  });

  it('fetches nothing until it is expanded', async () => {
    const { container, provider } = mount({ tagged: true });
    // A failure injected on the very method the card would call: if the card
    // fetched eagerly, this would already have surfaced.
    provider.fixture.setFailure('listElementHistory', { kind: 'throw', message: 'would have fetched' });
    await advance(0);
    assert.ok(!/would have fetched/.test(container.textContent ?? ''));
  });

  it('reads a re-GUID as one life, ending where the element was added', async () => {
    const { container } = mount({ tagged: true });
    toggle(container);
    await advance(0);

    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    assert.match(text, /Modified/);
    // The rename is reported as such, naming the key the element used to
    // carry — not as "added" on the day it was re-GUIDed.
    assert.match(text, /Renamed from wall-a/);
    assert.match(text, /Added/);
  });

  it('names the changed components in readable form', async () => {
    const { container } = mount({ tagged: true });
    toggle(container);
    await advance(0);
    const text = container.textContent ?? '';
    // `attr:core` → `core`: the prefix is the diff engine's namespace and
    // noise to a reader, but the NAME itself is the authored IFC name and is
    // never rewritten.
    assert.match(text, /core/);
    assert.ok(!/attr:core/.test(text), 'the engine namespace prefix is stripped');
  });

  it('says so when the source has no element history', async () => {
    const { container } = mount({
      tagged: true,
      capabilities: { commits: { payloadFormats: ['ifc-step'], elementHistory: false } },
    });
    toggle(container);
    await advance(0);
    assert.match(container.textContent ?? '', /Element history is not available for this source/);
  });

  it('surfaces a provider failure instead of an empty list', async () => {
    const { container, provider } = mount({ tagged: true });
    provider.fixture.setFailure('listElementHistory', { kind: 'throw', message: 'history service down' });
    toggle(container);
    await advance(0);
    assert.match(container.textContent ?? '', /history service down/);
  });
});
