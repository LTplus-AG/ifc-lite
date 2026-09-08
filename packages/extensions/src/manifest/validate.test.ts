/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct unit coverage for `validateManifest` and the primitives it
 * builds on.
 *
 * The pre-existing `manifest.test.ts` drives the validator through
 * fixture files and asserts only `result.ok`. That shape is satisfied by
 * *any* error, so it pins almost none of the individual field rules:
 * mutation testing showed the id-casing rule, the engine-range rule, the
 * blank-string rule, the `l10n` / `tests` / `author` / `entry` type rules
 * and both `optionalString` call sites could all be disabled with the
 * whole suite still green. Each test below asserts a specific error
 * `code` at a specific `path`, so it fails when its own rule goes away.
 */

import { describe, expect, it } from 'vitest';
import { validateManifest } from './validate.js';
import type { ValidationError } from '../types.js';

/** Smallest manifest the validator accepts; spread + override per test. */
function baseManifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'com.example.base',
    name: 'Base',
    description: 'A base manifest.',
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=2.0.0' },
    capabilities: ['model.read'],
    activation: ['onStartup'],
    entry: {},
  };
}

function errorsOf(input: unknown): ValidationError[] {
  const r = validateManifest(input);
  return r.ok ? [] : r.errors;
}

function hasError(input: unknown, path: string, code: string): boolean {
  return errorsOf(input).some((e) => e.path === path && e.code === code);
}

describe('validateManifest — the baseline really is valid', () => {
  it('accepts the base manifest used by every test below', () => {
    const r = validateManifest(baseManifest());
    if (!r.ok) console.error(r.errors);
    expect(r.ok).toBe(true);
  });
});

describe('validateManifest — id', () => {
  // The ID_RE comment states the canonical id is lowercase and that an
  // earlier `/i` flag was a bug. The only invalid-id fixture contains
  // spaces, so it is rejected either way — nothing pinned the casing
  // rule until now.
  it('rejects an id with uppercase letters, which the fixtures never covered', () => {
    expect(hasError({ ...baseManifest(), id: 'com.Example.Widget' }, 'id', 'invalid_id')).toBe(true);
  });

  it('accepts lowercase reverse-DNS ids with hyphens and underscores', () => {
    expect(validateManifest({ ...baseManifest(), id: 'com.example.fire-rating_v2' }).ok).toBe(true);
  });

  it('rejects an id with a leading separator', () => {
    expect(hasError({ ...baseManifest(), id: '.com.example' }, 'id', 'invalid_id')).toBe(true);
  });
});

describe('validateManifest — version', () => {
  it('rejects a two-segment version', () => {
    expect(hasError({ ...baseManifest(), version: '1.0' }, 'version', 'invalid_semver')).toBe(true);
  });

  it('accepts a prerelease + build version', () => {
    expect(validateManifest({ ...baseManifest(), version: '1.2.3-rc.1+build.5' }).ok).toBe(true);
  });
});

describe('validateManifest — engines', () => {
  it('rejects a range string that is only whitespace', () => {
    const input = { ...baseManifest(), engines: { ifcLiteSdk: '   ' } };
    expect(hasError(input, 'engines.ifcLiteSdk', 'required')).toBe(true);
  });

  // ENGINE_RANGE_RE is the only thing standing between a typo'd range
  // and the host loader's SemVer comparison, and no fixture exercised it.
  it('rejects a range containing characters no SemVer range can contain', () => {
    const input = { ...baseManifest(), engines: { ifcLiteSdk: 'latest' } };
    expect(hasError(input, 'engines.ifcLiteSdk', 'invalid_engine_range')).toBe(true);
  });

  it('accepts the documented range forms', () => {
    for (const range of ['>=2.4.0 <3.0.0', '^2.4.0', '2.x', '~2.4']) {
      const r = validateManifest({ ...baseManifest(), engines: { ifcLiteSdk: range } });
      if (!r.ok) console.error(range, r.errors);
      expect(r.ok).toBe(true);
    }
  });
});

describe('validateManifest — required strings must not be blank', () => {
  // `requireString`'s trim() check: without it a manifest whose name is
  // "   " validates and installs with an invisible display name.
  it.each(['name', 'description', 'id', 'version'])(
    'rejects a whitespace-only "%s"',
    (field) => {
      const input = { ...baseManifest(), [field]: '   ' };
      const codes = errorsOf(input).filter((e) => e.path === field).map((e) => e.code);
      expect(codes).toContain('invalid_value');
    },
  );

  it('reports type_mismatch (not invalid_value) for a non-string name', () => {
    expect(hasError({ ...baseManifest(), name: 42 }, 'name', 'type_mismatch')).toBe(true);
  });
});

describe('validateManifest — optional strings', () => {
  // Both `optionalString` call sites (license, readme) were unpinned.
  it.each(['license', 'readme'])('rejects a non-string "%s"', (field) => {
    expect(hasError({ ...baseManifest(), [field]: 7 }, field, 'type_mismatch')).toBe(true);
  });

  it.each(['license', 'readme'])('accepts an absent "%s"', (field) => {
    const input = baseManifest();
    delete input[field];
    expect(validateManifest(input).ok).toBe(true);
  });
});

describe('validateManifest — author', () => {
  it('rejects a non-object author', () => {
    expect(hasError({ ...baseManifest(), author: 'Jane' }, 'author', 'type_mismatch')).toBe(true);
  });

  it('requires a non-blank author.name', () => {
    const input = { ...baseManifest(), author: { name: '  ' } };
    expect(hasError(input, 'author.name', 'required')).toBe(true);
  });

  it('rejects a non-string author.url', () => {
    const input = { ...baseManifest(), author: { name: 'Jane', url: 42 } };
    expect(hasError(input, 'author.url', 'type_mismatch')).toBe(true);
  });

  it('rejects a non-string author.email', () => {
    const input = { ...baseManifest(), author: { name: 'Jane', email: [] } };
    expect(hasError(input, 'author.email', 'type_mismatch')).toBe(true);
  });

  it('accepts a fully-populated author', () => {
    const input = {
      ...baseManifest(),
      author: { name: 'Jane', url: 'https://example.invalid', email: 'jane@example.invalid' },
    };
    expect(validateManifest(input).ok).toBe(true);
  });
});

describe('validateManifest — entry', () => {
  it('rejects a non-string entry.activate', () => {
    const input = { ...baseManifest(), entry: { activate: 42 } };
    expect(hasError(input, 'entry.activate', 'type_mismatch')).toBe(true);
  });

  it('rejects a non-string entry.deactivate', () => {
    const input = { ...baseManifest(), entry: { deactivate: {} } };
    expect(hasError(input, 'entry.deactivate', 'type_mismatch')).toBe(true);
  });

  it('rejects a non-object entry.commands map', () => {
    const input = { ...baseManifest(), entry: { commands: ['a'] } };
    expect(hasError(input, 'entry.commands', 'type_mismatch')).toBe(true);
  });

  it('rejects a non-string value inside entry.triggers', () => {
    const input = { ...baseManifest(), entry: { triggers: { 'ext.a': 3 } } };
    expect(hasError(input, 'entry.triggers.ext.a', 'type_mismatch')).toBe(true);
  });
});

describe('validateManifest — tests', () => {
  it('rejects a blank test name / command / fixture', () => {
    const input = {
      ...baseManifest(),
      tests: [{ name: ' ', command: '', fixture: '  ', expect: {} }],
    };
    const paths = errorsOf(input).map((e) => e.path);
    expect(paths).toContain('tests[0].name');
    expect(paths).toContain('tests[0].command');
    expect(paths).toContain('tests[0].fixture');
  });

  it('requires test.expect to be an object', () => {
    const input = {
      ...baseManifest(),
      tests: [{ name: 'n', command: 'c', fixture: 'f' }],
    };
    expect(hasError(input, 'tests[0].expect', 'required')).toBe(true);
  });

  it('accepts a well-formed test entry', () => {
    const input = {
      ...baseManifest(),
      tests: [{ name: 'n', command: 'ext.example.cmd', fixture: 'f.ifc', expect: { ok: true } }],
    };
    expect(validateManifest(input).ok).toBe(true);
  });
});

describe('validateManifest — l10n', () => {
  it('rejects a non-object locale bag', () => {
    const input = { ...baseManifest(), l10n: { de: 'nope' } };
    expect(hasError(input, 'l10n.de', 'type_mismatch')).toBe(true);
  });

  it('rejects a non-string translation value', () => {
    const input = { ...baseManifest(), l10n: { de: { title: 42 } } };
    expect(hasError(input, 'l10n.de.title', 'type_mismatch')).toBe(true);
  });

  it('accepts a well-formed l10n bag', () => {
    const input = { ...baseManifest(), l10n: { de: { title: 'Titel' } } };
    expect(validateManifest(input).ok).toBe(true);
  });
});

describe('validateManifest — capabilities and activation', () => {
  it('rejects a non-string capability entry with an indexed path', () => {
    const input = { ...baseManifest(), capabilities: [42] };
    expect(hasError(input, 'capabilities[0]', 'type_mismatch')).toBe(true);
  });

  it('rejects a non-array activation list', () => {
    expect(hasError({ ...baseManifest(), activation: 'onStartup' }, 'activation', 'required')).toBe(true);
  });
});
