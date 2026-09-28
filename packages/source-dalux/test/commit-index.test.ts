/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The version-set → commit-history MAPPING, which the conformance suite
 * cannot check because it is a claim about THIS provider's reading of
 * Dalux's data rather than about every commit-aware provider.
 *
 * The three that matter:
 *  - two sets pinning one revision are ONE commit, not two;
 *  - ordering survives Dalux's DATE-ONLY timestamps (the `version` revision
 *    number is why);
 *  - a digest never claims an algorithm nobody verified.
 *
 * ## The field shapes here are the ones a live tenant returns
 *
 * Checked against a real Dalux Build project (22 version sets, 75 IFC files)
 * on 2026-09-26, because two of them are nothing like what the OpenAPI
 * schema's bare types suggest:
 *
 *  - `contentHash` is `<43-char base64url>.<ext>` — a 256-bit hash, NOT hex,
 *    with the file extension appended (`"wbX4Pzz…QhTM.ifc"`). This is the
 *    evidence behind `dalux-content:`: the value cannot be presented as the
 *    contract's preferred `sha256:<hex>` without re-encoding it, and the
 *    algorithm is undocumented and unverified.
 *  - `lastModified` is a DATE, no time (`"2026-03-03"`). Every revision
 *    landing on one day therefore ties, which makes the `version` signal
 *    load-bearing in production rather than a fallback for an edge case.
 *  - `version` is populated with real revision counts ("1", "5", "36",
 *    "48") on a plain `files` area — broader than the schema's "shared or
 *    published" note claims.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { DaluxBuildProvider } from '../src/provider.js';
import { invalidateCommitIndex } from '../src/commit-index.js';
import { createDaluxApiMock, createDaluxMockContext, type DaluxMockWorld } from './dalux-api-mock.js';

const REF = { projectId: 'p-alpha', modelId: 'file-structural' };

function world(overrides: { readonly stripRevisionNumbers?: boolean; readonly flatTimestamps?: boolean } = {}): DaluxMockWorld {
  const revision = (id: string, version: string, lastModified: string) => ({
    fileRevisionId: id,
    content: `BYTES-${id}`,
    // The live shape: 43 base64url chars plus the extension.
    contentHash: `${id === 'rev-1' ? 'UHzihQD4dCu24kKvULPHRkkA6u0d7E8SUtnF9UFk4Ow'
      : id === 'rev-2' ? 'xlywWAZAIU4pLMv0wQr-RygfGURg0XO5SHhGi18huFc'
      : 'wbX4PzzI6iWxaKnSMCkmV3RP8vQv3JCbwCuyHd6QhTM'}.ifc`,
    ...(overrides.stripRevisionNumbers ? {} : { version }),
    // "Dalux answers with the file's CURRENT metadata" — every revision
    // reporting one timestamp, which is the reading that would collapse a
    // timestamp-only ordering.
    lastModified: overrides.flatTimestamps ? '2026-09-25' : lastModified,
    lastModifiedByUserId: 'user-berg',
  });

  return {
    projects: [
      {
        projectId: 'p-alpha',
        projectName: 'Alpha Tower',
        fileAreas: [
          {
            fileAreaId: 'fa-models',
            fileAreaName: 'Models',
            fileAreaType: 'DOCUMENTS',
            folders: [],
            files: [
              {
                fileId: 'file-structural',
                fileName: 'structural.ifc',
                fileRevisionId: 'rev-3',
                contentHash: 'wbX4PzzI6iWxaKnSMCkmV3RP8vQv3JCbwCuyHd6QhTM.ifc',
                content: 'BYTES-rev-3',
                revisions: [
                  // Date-only, as Dalux sends them.
                  revision('rev-1', '1', '2026-03-03'),
                  revision('rev-2', '2', '2026-09-12'),
                  revision('rev-3', '3', '2026-09-25'),
                ],
              },
              { fileId: 'file-spec', fileName: 'spec.pdf', fileRevisionId: 'rev-spec', content: 'SPEC' },
            ],
          },
        ],
        versionSets: [
          { versionSetId: 'vs-1', name: 'Initial delivery', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-1', 'file-spec': 'rev-spec' } },
          { versionSetId: 'vs-2', name: 'Coordination round 14', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-2' } },
          { versionSetId: 'vs-3', name: 'Issued for tender', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-2' } },
          { versionSetId: 'vs-4', name: 'Coordination round 15', fileAreaId: 'fa-models', files: { 'file-structural': 'rev-3' } },
        ],
      },
    ],
  };
}

function setup(spec: DaluxMockWorld = world()) {
  invalidateCommitIndex();
  const provider = new DaluxBuildProvider();
  return { provider, ctx: createDaluxMockContext(createDaluxApiMock(spec, { pageSize: 1 })) };
}

describe('version sets as model history', () => {
  beforeEach(invalidateCommitIndex);

  it('lists only model files, never the documents a set also pins', async () => {
    const { provider, ctx } = setup();
    const models = await provider.listModels!(ctx, 'p-alpha');
    expect(models.items.map((model) => model.id)).toEqual(['file-structural']);
    expect(models.items[0].name).toBe('structural.ifc');
    expect(models.items[0].commitCount).toBe(3);
  });

  it('collapses two sets pinning one revision into a single commit', async () => {
    const { provider, ctx } = setup();
    const commits = await provider.listCommits!(ctx, REF);

    // vs-2 and vs-3 both pin rev-2. Three revisions, four sets, three rows:
    // the model did not change between vs-2 and vs-3 and must not read as if
    // it did.
    expect(commits.items.map((commit) => commit.id)).toEqual(['rev-3', 'rev-2', 'rev-1']);
    const shared = commits.items.find((commit) => commit.id === 'rev-2')!;
    // Both set names survive, so the coordination context is not lost.
    expect(shared.message).toBe('Coordination round 14 (also in Issued for tender)');
    expect(shared.meta?.versionSetIds).toEqual(['vs-2', 'vs-3']);
  });

  it('chains each commit onto the next older revision', async () => {
    const { provider, ctx } = setup();
    const commits = await provider.listCommits!(ctx, REF);
    expect(commits.items.map((commit) => commit.parents)).toEqual([['rev-2'], ['rev-1'], []]);
  });

  it('carries the pinned revision author and timestamp, not the file head', async () => {
    const { provider, ctx } = setup();
    const commits = await provider.listCommits!(ctx, REF);
    const oldest = commits.items[2];
    expect(oldest.createdAt).toBe('2026-03-03');
    expect(oldest.author?.id).toBe('user-berg');
  });

  it('orders by revision number even when every timestamp is identical', async () => {
    // NOT a hypothetical: Dalux's `lastModified` is date-only, so every
    // revision uploaded on one day ties, and a timestamp-only ordering makes
    // the timeline arbitrary on exactly the days a team is working. The same
    // collapse happens if Dalux ever answers with the file's CURRENT
    // metadata for every pinned row. `File.version` is the revision number
    // and outranks the timestamp for both reasons.
    const { provider, ctx } = setup(world({ flatTimestamps: true }));
    const commits = await provider.listCommits!(ctx, REF);
    expect(commits.items.map((commit) => commit.id)).toEqual(['rev-3', 'rev-2', 'rev-1']);
  });

  it('falls back to sweep order when neither revision numbers nor timestamps separate the rows', async () => {
    const { provider, ctx } = setup(world({ flatTimestamps: true, stripRevisionNumbers: true }));
    const commits = await provider.listCommits!(ctx, REF);
    // Last set swept wins as newest — a stated assumption about an
    // undocumented list order, and the only signal left here.
    expect(commits.items.map((commit) => commit.id)).toEqual(['rev-3', 'rev-2', 'rev-1']);
  });

  it('reports the newest revision as the head', async () => {
    const { provider, ctx } = setup();
    const model = await provider.getModel!(ctx, REF);
    expect(model.headCommitId).toBe('rev-3');
  });
});

describe('artifact digests', () => {
  beforeEach(invalidateCommitIndex);

  it('never claim sha256 for a hash whose algorithm Dalux does not document', async () => {
    const { provider, ctx } = setup();
    const commits = await provider.listCommits!(ctx, REF);
    for (const commit of commits.items) {
      // `dalux-content:<43 base64url chars>.<ext>` — the live shape.
      expect(commit.artifact.digest).toMatch(/^dalux-content:[A-Za-z0-9_-]{43}\.\w+$/);
      // Labelling it `sha256:` would make a host "verify" bytes against a
      // hash of a different algorithm — rejecting good bytes, or worse.
      expect(commit.artifact.digest.startsWith('sha256:')).toBe(false);
    }
  });

  it('are a CONTENT hash, so identical bytes share one — which is legal', async () => {
    // Observed live: one `contentHash` appearing under two different file
    // ids with the same byte size. A conformance suite must not require
    // per-commit uniqueness, and this provider must not synthesise it.
    const { provider, ctx } = setup();
    const commits = await provider.listCommits!(ctx, REF);
    const digests = commits.items.map((commit) => commit.artifact.digest);
    expect(digests.every((digest) => digest.startsWith('dalux-content:'))).toBe(true);
  });

  it('still tell two revisions apart, which is what the field is for', async () => {
    const { provider, ctx } = setup();
    const commits = await provider.listCommits!(ctx, REF);
    const digests = commits.items.map((commit) => commit.artifact.digest);
    expect(new Set(digests).size).toBe(digests.length);
  });
});

describe('loadCommit', () => {
  beforeEach(invalidateCommitIndex);

  it('downloads the exact pinned revision, not the file head', async () => {
    const { provider, ctx } = setup();
    const payload = await provider.loadCommit!(ctx, { ...REF, commitId: 'rev-1' });
    expect(new TextDecoder().decode(payload.bytes)).toBe('BYTES-rev-1');
    expect(payload.format).toBe('ifc-step');
    expect(payload.artifactDigest).toBe('dalux-content:UHzihQD4dCu24kKvULPHRkkA6u0d7E8SUtnF9UFk4Ow.ifc');
  });

  it('fetches through the link Dalux supplied, not a hand-built URL', async () => {
    // Measured live: a version-set file row's `downloadLink` is
    // `/1.0/.../version_sets/{vs}/files/{f}/revisions/{r}/content`, NOT the
    // file-area-scoped `/2.0/.../file_areas/{fa}/...` route. The mock serves
    // both, so only inspecting the URL actually requested can tell the two
    // apart — and building it by hand was reaching for a route Dalux does
    // not advertise for a pinned revision.
    invalidateCommitIndex();
    const requested: string[] = [];
    const inner = createDaluxApiMock(world(), { pageSize: 1 });
    const spy: typeof fetch = (input, init) => {
      requested.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return inner(input, init);
    };
    const provider = new DaluxBuildProvider();
    await provider.loadCommit!(createDaluxMockContext(spy), { ...REF, commitId: 'rev-1' });

    const content = requested.filter((url) => url.includes('/content'));
    expect(content).toHaveLength(1);
    expect(content[0]).toContain('/version_sets/vs-1/files/file-structural/revisions/rev-1/content');
    expect(content[0]).not.toContain('/file_areas/');
  });

  it('falls back to the documented file-area route when no link is supplied', async () => {
    // `downloadLink` is nullable in the schema, and the file-area route is
    // documented and does take a revision id — so the fallback is a real
    // path, not dead code.
    invalidateCommitIndex();
    const requested: string[] = [];
    const inner = createDaluxApiMock(world(), { pageSize: 1 });
    const stripped: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requested.push(url);
      const response = await inner(input, init);
      if (!url.includes('/version_sets/') || !url.endsWith('/files')) return response;
      const body = JSON.parse(await response.text()) as { items: { data: Record<string, unknown> }[] };
      for (const item of body.items) delete item.data.downloadLink;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const provider = new DaluxBuildProvider();
    const payload = await provider.loadCommit!(createDaluxMockContext(stripped), { ...REF, commitId: 'rev-1' });

    expect(new TextDecoder().decode(payload.bytes)).toBe('BYTES-rev-1');
    expect(requested.filter((url) => url.includes('/content'))[0]).toContain('/file_areas/fa-models/');
  });

  it('refuses a format the stored bytes are not', async () => {
    const { provider, ctx } = setup();
    await expect(
      provider.loadCommit!(ctx, { ...REF, commitId: 'rev-1' }, { accept: ['ifcx'] }),
    ).rejects.toMatchObject({ code: 'unsupported-format' });
  });

  it('reports a model no version set covers as not-found', async () => {
    const { provider, ctx } = setup();
    await expect(
      provider.getModel!(ctx, { projectId: 'p-alpha', modelId: 'file-spec' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('the sweep', () => {
  beforeEach(invalidateCommitIndex);

  it('is built once and shared, not re-run per call', async () => {
    let requests = 0;
    const spec = world();
    const counting: typeof fetch = (input, init) => {
      requests += 1;
      return createDaluxApiMock(spec, { pageSize: 1 })(input, init);
    };
    invalidateCommitIndex();
    const provider = new DaluxBuildProvider();
    const ctx = createDaluxMockContext(counting);

    await provider.listModels!(ctx, 'p-alpha');
    const afterFirst = requests;
    await provider.listCommits!(ctx, REF);
    await provider.getModel!(ctx, REF);

    // One request per version set plus the set listing is the whole cost of
    // this feature; paying it again on every panel interaction is what the
    // cache exists to prevent.
    expect(requests).toBe(afterFirst);
  });
});
