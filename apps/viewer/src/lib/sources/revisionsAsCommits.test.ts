/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The revision-only adapter (spec 01 §8): what the History panel can show for
 * a Dropbox or Microsoft Graph file, with no provider changes at all.
 *
 * The digest is the interesting part. A revision's bytes have not been
 * fetched, so its hash is genuinely unknown — and the adapter says `unknown:`
 * rather than inventing something that LOOKS like a hash, because the host
 * verifies `payload.artifactDigest` against the commit before loading and a
 * fabricated `sha256:…` would make every open report corruption.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FileSourceProvider, PluginContext, SourceFile, SourceRevision } from '@ifc-lite/plugin-api';

import {
  fileAsModel,
  isUnknownDigest,
  loadRevisionHistoryPage,
  revisionsAsCommits,
  unknownDigest,
} from './revisionsAsCommits.js';

const FILE: SourceFile = {
  id: 'file-1',
  name: 'structural.ifc',
  containerId: 'folder-1',
  currentRevisionId: '3.0',
  modifiedAt: '2026-09-25T09:15:00.000Z',
};

/** Newest first, as `listRevisions` returns them. */
const REVISIONS: SourceRevision[] = [
  { id: '3.0', label: 'Revision 3', createdAt: '2026-09-25T09:15:00.000Z', createdBy: 'J. Hansen', sizeBytes: 300 },
  { id: '2.0', label: 'Revision 2', createdAt: '2026-09-12T11:30:00.000Z', createdBy: 'M. Berg', sizeBytes: 200 },
  { id: '1.0', label: 'Revision 1', createdAt: '2026-03-03T08:00:00.000Z', sizeBytes: 100 },
];

function makeProvider(overrides: {
  revisionHistory?: boolean;
  downloadHistoricalRevisions?: boolean;
  listRevisions?: FileSourceProvider['listRevisions'];
}): FileSourceProvider {
  return {
    manifest: {
      name: 'drive',
      title: 'Drive',
      api: '^2.0.0',
      auth: 'preferences',
      permissions: { network: ['drive.invalid'] },
      preferences: [],
      capabilities: {
        containerListing: 'direct-children',
        listFilesIsRecursive: false,
        revisionHistory: overrides.revisionHistory ?? true,
        downloadHistoricalRevisions: overrides.downloadHistoricalRevisions ?? true,
        changeDetection: false,
        search: false,
      },
      contributes: { fileSources: [] },
    },
    listProjects: async () => ({ items: [] }),
    listContainers: async () => ({ items: [] }),
    listFiles: async () => ({ items: [] }),
    download: async () => new ArrayBuffer(0),
    ...(overrides.listRevisions ? { listRevisions: overrides.listRevisions } : {}),
  };
}

const CTX = {} as PluginContext;
const REF = { projectId: 'p1', containerId: 'folder-1', fileId: 'file-1' };

describe('revisionsAsCommits', () => {
  it('builds a linear chain, newest first, each parented on the next older', () => {
    const commits = revisionsAsCommits(REVISIONS, FILE, 'p1');
    assert.deepEqual(commits.map((c) => c.id), ['3.0', '2.0', '1.0']);
    assert.deepEqual(commits.map((c) => c.parents), [['2.0'], ['1.0'], []]);
  });

  it('carries the revision LABEL as the message, not an invented one', () => {
    const commits = revisionsAsCommits(REVISIONS, FILE, 'p1');
    // `"2.0"` is what SharePoint calls this version; writing a commit message
    // here would be putting words in the author's mouth.
    assert.equal(commits[1].message, 'Revision 2');
    assert.equal(commits[1].author?.displayName, 'M. Berg');
  });

  it('reports an UNKNOWN digest rather than one that looks real', () => {
    const commits = revisionsAsCommits(REVISIONS, FILE, 'p1');
    for (const commit of commits) {
      assert.ok(isUnknownDigest(commit.artifact.digest), `${commit.id} must not claim a hash nobody computed`);
      assert.ok(!commit.artifact.digest.startsWith('sha256:'));
    }
    assert.equal(commits[0].artifact.digest, unknownDigest('3.0'));
  });

  it('records where the bytes come from, so the loader can address them', () => {
    const commits = revisionsAsCommits(REVISIONS, FILE, 'p1');
    assert.deepEqual(commits[0].origin, { fileId: 'file-1', revisionId: '3.0' });
  });

  it('never marks a revision unpublished — a file store has no review state', () => {
    assert.ok(revisionsAsCommits(REVISIONS, FILE, 'p1').every((c) => c.status === 'published'));
  });
});

describe('fileAsModel', () => {
  it('uses the file id as the model id and its current revision as the head', () => {
    const model = fileAsModel(FILE, 'p1');
    assert.equal(model.id, 'file-1');
    assert.equal(model.headCommitId, '3.0');
    assert.equal(model.name, 'structural.ifc');
  });
});

describe('loadRevisionHistoryPage', () => {
  it('returns the chain and reports that history can be opened', async () => {
    const provider = makeProvider({
      listRevisions: async () => ({ items: REVISIONS }),
    });
    const page = await loadRevisionHistoryPage(provider, CTX, REF, FILE);
    assert.ok(page);
    assert.deepEqual(page!.commits.map((c) => c.id), ['3.0', '2.0', '1.0']);
    assert.equal(page!.canOpenHistorical, true);
  });

  it('reports that Open must be DISABLED when historical bytes cannot be fetched', async () => {
    // Microsoft Graph is the reference case: full history in the UI, and no
    // way for a browser to retrieve those bytes. Offering Open would be
    // offering an action that can only fail.
    const provider = makeProvider({
      downloadHistoricalRevisions: false,
      listRevisions: async () => ({ items: REVISIONS }),
    });
    const page = await loadRevisionHistoryPage(provider, CTX, REF, FILE);
    assert.equal(page!.canOpenHistorical, false);
  });

  it('returns null for a provider with no revision history at all', async () => {
    const provider = makeProvider({ revisionHistory: false });
    assert.equal(await loadRevisionHistoryPage(provider, CTX, REF, FILE), null);
  });

  it('returns null when the capability is declared but the method is missing', async () => {
    // A manifest can lie; the panel must degrade to "no history" rather than
    // throw on a call that does not exist.
    const provider = makeProvider({ revisionHistory: true });
    assert.equal(await loadRevisionHistoryPage(provider, CTX, REF, FILE), null);
  });

  it('passes the cursor through so the panel can page', async () => {
    const provider = makeProvider({
      listRevisions: async (_ctx, _ref, options) =>
        options?.cursor === 'next'
          ? { items: REVISIONS.slice(2) }
          : { items: REVISIONS.slice(0, 2), cursor: 'next' },
    });
    const first = await loadRevisionHistoryPage(provider, CTX, REF, FILE);
    assert.equal(first!.cursor, 'next');
    const second = await loadRevisionHistoryPage(provider, CTX, REF, FILE, { cursor: 'next' });
    assert.equal(second!.cursor, undefined);
    assert.deepEqual(second!.commits.map((c) => c.id), ['1.0']);
  });
});
