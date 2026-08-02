/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the identity-map sidecar (issue #1891) — the on-disk artifact that
 * carries identity claims for plain-file workflows.
 *
 * The format's one non-obvious job is refusing to be a *floating* rename list:
 * it pins the content digest of both revisions the claims were verified
 * against, so replaying it on a different pair is caught rather than silently
 * asserting an identity nobody reviewed.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import { identityMapFromContentMatches } from './identity-map.js';
import {
  IDENTITY_MAP_SIDECAR_FORMAT,
  IDENTITY_MAP_SIDECAR_VERSION,
  createIdentityMapSidecar,
  identityMapSidecarMismatches,
  keyAliasesFromSidecar,
  parseIdentityMapSidecar,
  serializeIdentityMapSidecar,
  validateIdentityMapSidecar,
  type IdentityMapSidecar,
} from './identity-sidecar.js';
import type { EntityFingerprint } from './types.js';

const BASE = { hash: 'sha256:aaa', path: 'v1.ifc' };
const HEAD = { hash: 'sha256:bbb', path: 'v2.ifc' };

function fp(
  key: string,
  opts: Partial<Omit<EntityFingerprint<number>, 'key'>> = {},
): EntityFingerprint<number> {
  return {
    key,
    ifcType: opts.ifcType ?? 'IfcWall',
    dataHash: opts.dataHash ?? 'd0',
    geometryHash: opts.geometryHash,
    ref: 0,
  };
}

describe('createIdentityMapSidecar', () => {
  it('stamps the format discriminator and version, and pins both model identities', () => {
    const sidecar = createIdentityMapSidecar({
      base: BASE,
      head: HEAD,
      entries: [{ base: 'o', here: 'n', reason: 'content-match:renamed' }],
    });

    expect(sidecar.format).toBe(IDENTITY_MAP_SIDECAR_FORMAT);
    expect(sidecar.version).toBe(IDENTITY_MAP_SIDECAR_VERSION);
    expect(sidecar.base).toEqual(BASE);
    expect(sidecar.head).toEqual(HEAD);
  });

  it('sorts entries so the same comparison writes the same bytes', () => {
    const one = createIdentityMapSidecar({
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'b2', here: 'h2', reason: 'content-match:moved' },
        { base: 'b1', here: 'h1', reason: 'content-match:renamed' },
      ],
    });
    const other = createIdentityMapSidecar({
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'b1', here: 'h1', reason: 'content-match:renamed' },
        { base: 'b2', here: 'h2', reason: 'content-match:moved' },
      ],
    });

    expect(one.entries.map((e) => e.base)).toEqual(['b1', 'b2']);
    expect(serializeIdentityMapSidecar(one)).toBe(serializeIdentityMapSidecar(other));
  });

  it('de-duplicates an identical claim but keeps two head entities on one base', () => {
    const sidecar = createIdentityMapSidecar({
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'b', here: 'h', reason: 'content-match:renamed' },
        { base: 'b', here: 'h', reason: 'content-match:renamed' },
        { base: 'b', here: 'other', reason: 'content-match:moved' },
      ],
    });

    // The repeat is noise. Two `here`s on one `base` is a fact the consumer
    // must see: only it knows whether both head entities are still live.
    expect(sidecar.entries).toEqual([
      { base: 'b', here: 'h', reason: 'content-match:renamed' },
      { base: 'b', here: 'other', reason: 'content-match:moved' },
    ]);
  });

  it('refuses to build a map that claims two base identities for one head key', () => {
    expect(() =>
      createIdentityMapSidecar({
        base: BASE,
        head: HEAD,
        entries: [
          { base: 'b1', here: 'h', reason: 'hand-written' },
          { base: 'b2', here: 'h', reason: 'hand-written' },
        ],
      }),
    ).toThrow(/two different base identities for here "h"/);
  });

  it('omits `created` entirely unless the producer supplied one', () => {
    const bare = createIdentityMapSidecar({ base: BASE, head: HEAD, entries: [] });
    expect('created' in bare).toBe(false);

    const stamped = createIdentityMapSidecar({
      base: BASE,
      head: HEAD,
      entries: [],
      created: '2026-08-02T00:00:00.000Z',
    });
    expect(stamped.created).toBe('2026-08-02T00:00:00.000Z');
  });

  it('rejects an unusable model identity rather than writing an unpinnable map', () => {
    expect(() =>
      createIdentityMapSidecar({ base: { hash: '' }, head: HEAD, entries: [] }),
    ).toThrow(/base\.hash/);
  });
});

describe('serialize / parse round trip', () => {
  it('round trips through JSON with a trailing newline', () => {
    const sidecar = createIdentityMapSidecar({
      base: BASE,
      head: HEAD,
      entries: [{ base: 'o', here: 'n', reason: 'content-match:renamed' }],
      created: '2026-08-02T00:00:00.000Z',
    });
    const text = serializeIdentityMapSidecar(sidecar);

    expect(text.endsWith('\n')).toBe(true);
    expect(parseIdentityMapSidecar(text)).toEqual(sidecar);
  });

  it('refuses malformed JSON', () => {
    expect(() => parseIdentityMapSidecar('{not json')).toThrow(/not JSON/);
  });

  it('refuses a stray JSON file that is not a sidecar', () => {
    expect(() => parseIdentityMapSidecar('{"hello":"world"}')).toThrow(/format must be/);
  });

  it('refuses an unknown version rather than guessing the shape', () => {
    const text = JSON.stringify({
      format: IDENTITY_MAP_SIDECAR_FORMAT,
      version: 99,
      base: BASE,
      head: HEAD,
      entries: [],
    });
    expect(() => parseIdentityMapSidecar(text)).toThrow(/version must be 1/);
  });

  it('refuses a document with a malformed entry instead of applying the readable half', () => {
    const text = JSON.stringify({
      format: IDENTITY_MAP_SIDECAR_FORMAT,
      version: IDENTITY_MAP_SIDECAR_VERSION,
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'o', here: 'n', reason: 'content-match:renamed' },
        { base: 'o2', here: 42 },
      ],
    });
    expect(() => parseIdentityMapSidecar(text)).toThrow(/entries must be/);
  });

  it('refuses a document that claims two base identities for one head key', () => {
    const text = JSON.stringify({
      format: IDENTITY_MAP_SIDECAR_FORMAT,
      version: IDENTITY_MAP_SIDECAR_VERSION,
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'b1', here: 'h', reason: 'hand-written' },
        { base: 'b2', here: 'h', reason: 'hand-written' },
      ],
    });
    // Not "apply the first one": the document is self-contradictory, and no
    // pair of files can break the tie.
    expect(() => parseIdentityMapSidecar(text)).toThrow(
      /two different base identities for here "h"/,
    );
  });

  it('treats a self-claim as one of the two contradictory claims', () => {
    const text = JSON.stringify({
      format: IDENTITY_MAP_SIDECAR_FORMAT,
      version: IDENTITY_MAP_SIDECAR_VERSION,
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'h', here: 'h', reason: 'hand-written' },
        { base: 'b', here: 'h', reason: 'hand-written' },
      ],
    });
    expect(() => parseIdentityMapSidecar(text)).toThrow(/two different base identities/);
  });
});

describe('validateIdentityMapSidecar', () => {
  it('accepts a well-formed document', () => {
    expect(
      validateIdentityMapSidecar(createIdentityMapSidecar({ base: BASE, head: HEAD, entries: [] })),
    ).toEqual([]);
  });

  it('reports every problem, not just the first', () => {
    const errors = validateIdentityMapSidecar({
      format: 'nope',
      version: 2,
      base: null,
      head: { hash: 5 },
      created: 'not-a-date',
      entries: 'no',
    });
    expect(errors).toHaveLength(6);
  });

  it('rejects a non-object', () => {
    expect(validateIdentityMapSidecar(null)).toEqual(['sidecar must be an object']);
    expect(validateIdentityMapSidecar([])).toEqual(['sidecar must be an object']);
  });
});

describe('identityMapSidecarMismatches — the pin', () => {
  it('passes when both digests match', () => {
    const sidecar = createIdentityMapSidecar({ base: BASE, head: HEAD, entries: [] });
    expect(identityMapSidecarMismatches(sidecar, { base: BASE, head: HEAD })).toEqual([]);
  });

  it('catches a map replayed against a different head revision', () => {
    const sidecar = createIdentityMapSidecar({ base: BASE, head: HEAD, entries: [] });
    const problems = identityMapSidecarMismatches(sidecar, {
      base: BASE,
      head: { hash: 'sha256:ccc' },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('head model does not match');
  });

  it('catches both sides at once', () => {
    const sidecar = createIdentityMapSidecar({ base: BASE, head: HEAD, entries: [] });
    expect(
      identityMapSidecarMismatches(sidecar, {
        base: { hash: 'sha256:xxx' },
        head: { hash: 'sha256:yyy' },
      }),
    ).toHaveLength(2);
  });

  it('ignores the path: a moved file is still the same file', () => {
    const sidecar = createIdentityMapSidecar({ base: BASE, head: HEAD, entries: [] });
    expect(
      identityMapSidecarMismatches(sidecar, {
        base: { hash: 'sha256:aaa', path: '/elsewhere/v1.ifc' },
        head: { hash: 'sha256:bbb', path: '/elsewhere/v2.ifc' },
      }),
    ).toEqual([]);
  });
});

describe('keyAliasesFromSidecar', () => {
  it('maps here → base, the direction DiffOptions.keyAliases takes', () => {
    const sidecar = createIdentityMapSidecar({
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'old-a', here: 'new-a', reason: 'content-match:renamed' },
        { base: 'old-b', here: 'new-b', reason: 'content-match:moved' },
      ],
    });
    expect(keyAliasesFromSidecar(sidecar)).toEqual(
      new Map([
        ['new-a', 'old-a'],
        ['new-b', 'old-b'],
      ]),
    );
  });

  it('drops a self-claim as a no-op', () => {
    const sidecar = createIdentityMapSidecar({
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'same', here: 'same', reason: 'hand-written' },
        { base: 'b1', here: 'h', reason: 'hand-written' },
      ],
    });
    expect(keyAliasesFromSidecar(sidecar)).toEqual(new Map([['h', 'b1']]));
  });

  it('yields nothing for a head key two claims disagree about, and keeps the rest', () => {
    // Hand-built rather than via `createIdentityMapSidecar`, which now refuses
    // this document outright — the reader must not pick a winner either.
    const sidecar: IdentityMapSidecar = {
      format: IDENTITY_MAP_SIDECAR_FORMAT,
      version: IDENTITY_MAP_SIDECAR_VERSION,
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'b1', here: 'h', reason: 'hand-written' },
        { base: 'b2', here: 'h', reason: 'hand-written' },
        { base: 'ok-base', here: 'ok-here', reason: 'hand-written' },
      ],
    };
    // Not b1, not b2: an arbitrary winner is the one outcome this must never
    // produce, because it gets replayed and re-emitted as if it were reviewed.
    expect(keyAliasesFromSidecar(sidecar)).toEqual(new Map([['ok-here', 'ok-base']]));
  });

  it('does not let a self-claim hide the conflict it is part of', () => {
    const sidecar: IdentityMapSidecar = {
      format: IDENTITY_MAP_SIDECAR_FORMAT,
      version: IDENTITY_MAP_SIDECAR_VERSION,
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'h', here: 'h', reason: 'hand-written' },
        { base: 'b', here: 'h', reason: 'hand-written' },
      ],
    };
    expect(keyAliasesFromSidecar(sidecar)).toEqual(new Map());
  });

  it('leaves two head keys claiming one base for resolveKeyAliases to judge', () => {
    const sidecar = createIdentityMapSidecar({
      base: BASE,
      head: HEAD,
      entries: [
        { base: 'b', here: 'h1', reason: 'hand-written' },
        { base: 'b', here: 'h2', reason: 'hand-written' },
      ],
    });
    // Both survive the reader; only the engine knows whether both head
    // entities are live, and rule 4 drops them only if they are.
    expect(keyAliasesFromSidecar(sidecar)).toEqual(
      new Map([
        ['h1', 'b'],
        ['h2', 'b'],
      ]),
    );
  });
});

describe('the full plain-file loop', () => {
  it('run 1 writes a sidecar; run 2 reads it and the re-GUID is gone', () => {
    const base = [fp('old', { dataHash: 'd1', geometryHash: 1n })];
    const head = [fp('new', { dataHash: 'd1', geometryHash: 1n })];

    const first = diffModels(base, head, { matchUnpairedByContent: true });
    const text = serializeIdentityMapSidecar(
      createIdentityMapSidecar({
        base: BASE,
        head: HEAD,
        entries: identityMapFromContentMatches(first.contentMatches),
      }),
    );

    // ... file written, reviewed, committed, read back ...
    const sidecar = parseIdentityMapSidecar(text);
    expect(identityMapSidecarMismatches(sidecar, { base: BASE, head: HEAD })).toEqual([]);

    const second = diffModels(base, head, {
      matchUnpairedByContent: true,
      keyAliases: keyAliasesFromSidecar(sidecar),
    });

    expect(second.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 1 });
    expect(second.contentMatches).toEqual([]);
    expect(second.appliedKeyAliases).toEqual(new Map([['new', 'old']]));
  });
});
