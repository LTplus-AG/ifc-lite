/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The History panel's states (spec 02 §4.3) and its timeline, driven through
 * a REAL commit-aware provider — `@ifc-lite/source-fixture`'s, registered
 * through `SourceHostProvider`'s `additionalProviders`, the same seam a host
 * application uses at bootstrap.
 *
 * Driving a real provider rather than a hand-rolled stub is what makes these
 * assertions worth anything: the fixture is the conformance oracle, so a
 * panel that renders correctly against it renders correctly against every
 * provider that passes the suite.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureSourceProvider } from '@ifc-lite/source-fixture';
import type { FixtureWorldSpec } from '@ifc-lite/source-fixture';

import { advance, cleanup, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { invalidateModelHistory } from '@/hooks/history/useModelHistory';
import { useViewerStore } from '@/store';
import type { CommitTag } from '@/store/slices/historySlice';
import { HistoryPanel } from './HistoryPanel';

const VIEWER_MODEL = 'viewer-model-1';
const PROVIDER = 'fixture';

function world(): FixtureWorldSpec {
  return {
    projects: [
      {
        id: 'proj-1',
        name: 'Alpha Tower',
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
                author: 'A. Holm',
                message: 'Initial delivery',
                fileName: 'structural-c1.ifc',
                content: 'COMMIT-1',
                fingerprints: [{ key: 'wall-a', ifcType: 'IfcWall', dataHash: 'd1' }],
              },
              {
                id: 'c2',
                parents: ['c1'],
                createdAt: '2026-09-12T11:30:00.000Z',
                author: 'M. Berg',
                message: 'Coordination round 14',
                fileName: 'structural-c2.ifc',
                content: 'COMMIT-2',
                fingerprints: [
                  { key: 'wall-a', ifcType: 'IfcWall', dataHash: 'd2' },
                  { key: 'door-a', ifcType: 'IfcDoor', dataHash: 'd3' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function commitTag(overrides: Partial<CommitTag> = {}): CommitTag {
  return {
    provider: PROVIDER,
    projectId: 'proj-1',
    sourceModelId: 'model-structural',
    commitId: 'c2',
    artifactDigest: 'sha256:unchecked',
    historical: false,
    loadedAt: 1,
    ...overrides,
  };
}

function seed(options: { commitTag?: CommitTag | null; noModel?: boolean } = {}) {
  const seeded = options.noModel
    ? { models: new Map(), activeModelId: null }
    : fixtureModels(fixtureModel(VIEWER_MODEL, { entities: [] }));
  useViewerStore.setState({
    ...seeded,
    commitTags: options.commitTag === null || options.commitTag === undefined
      ? new Map()
      : new Map([[VIEWER_MODEL, options.commitTag]]),
    sourceTags: new Map(),
    localLineage: new Map(),
    historyNewHeads: new Map(),
    historyFocusModelId: null,
    historyPickA: null,
    historyPickB: null,
  } as never);
}

function mount(capabilities?: Parameters<typeof createFixtureSourceProvider>[0]['capabilities']) {
  const provider = createFixtureSourceProvider({
    world: world(),
    ...(capabilities ? { capabilities } : {}),
  });
  const container = render(
    <SourceHostProvider additionalProviders={[() => provider]}>
      <HistoryPanel />
    </SourceHostProvider>,
  );
  return { container, provider };
}

/** All rendered text, whitespace-collapsed — the panel's states are messages. */
function textOf(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

describe('HistoryPanel states', () => {
  beforeEach(() => {
    // `useModelHistory` caches pages in a module-level map keyed by
    // provider|project|model, with NO expiry — the point of commits being
    // immutable. Across tests that means one test's pages are the next
    // test's starting state, so the cache is cleared rather than worked
    // around.
    invalidateModelHistory();
    useViewerStore.setState({ commitTags: new Map() } as never);
  });
  afterEach(cleanup);

  it('asks the user to open a model when nothing is loaded', async () => {
    seed({ noModel: true });
    const { container } = mount();
    await advance(0);
    assert.match(textOf(container), /Open a model to see its history/);
  });

  it('says history needs a source for a locally opened file', async () => {
    seed({ commitTag: null });
    const { container } = mount();
    await advance(0);
    assert.match(textOf(container), /History is available for models opened from a source/);
  });

  it('renders the commits newest first, with author and message', async () => {
    seed({ commitTag: commitTag() });
    const { container } = mount();
    await advance(0);

    const text = textOf(container);
    assert.match(text, /Coordination round 14/);
    assert.match(text, /Initial delivery/);
    assert.match(text, /M\. Berg/);
    assert.ok(
      text.indexOf('Coordination round 14') < text.indexOf('Initial delivery'),
      'newest first — the order listCommits guarantees',
    );
  });

  it('badges the head and the commit currently open', async () => {
    seed({ commitTag: commitTag({ commitId: 'c1', historical: true }) });
    const { container } = mount();
    await advance(0);

    const rows = [...container.querySelectorAll('[role="listitem"]')];
    assert.equal(rows.length, 2);
    // c2 is the head; c1 is what the viewer has open.
    assert.match(rows[0].textContent ?? '', /HEAD/);
    assert.match(rows[1].textContent ?? '', /LOADED/);
  });

  it('shows the change counts the provider computed', async () => {
    seed({ commitTag: commitTag() });
    const { container } = mount();
    await advance(0);
    // c2 adds door-a and modifies wall-a against c1.
    assert.match(textOf(container), /\+1 ~1/);
  });

  it('offers a Retry when the provider fails', async () => {
    seed({ commitTag: commitTag() });
    const { container, provider } = mount();
    provider.fixture.setFailure('listCommits', { kind: 'throw', message: 'commit service down', status: 503 });
    await advance(0);

    const text = textOf(container);
    assert.match(text, /commit service down/);
    assert.match(text, /Retry/);
  });

  it('says so plainly when the user may not see the history', async () => {
    seed({ commitTag: commitTag() });
    const { container, provider } = mount();
    // A `forbidden` reads differently from a transient failure: there is
    // nothing to retry, so the panel must not offer a button that can only
    // fail again.
    provider.fixture.setFailure('listCommits', { kind: 'throw', code: 'forbidden', message: 'no access', status: 403 });
    await advance(0);

    const text = textOf(container);
    assert.match(text, /You do not have access to this model's history/);
    assert.ok(!/Retry/.test(text), 'a forbidden history offers no Retry');
  });
});
