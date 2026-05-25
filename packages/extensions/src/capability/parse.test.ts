/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseCapabilities, parseCapability } from './parse.js';

describe('parseCapability — happy path', () => {
  it('parses scope.action with no target', () => {
    const r = parseCapability('model.read');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scope).toBe('model');
      expect(r.value.action).toBe('read');
      expect(r.value.target).toBeUndefined();
    }
  });

  it('parses scope.action with simple target', () => {
    const r = parseCapability('network.fetch:example.com');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.target?.raw).toBe('example.com');
      expect(r.value.target?.segments).toEqual([
        { kind: 'literal', value: 'example' },
        { kind: 'literal', value: 'com' },
      ]);
    }
  });

  it('parses universal wildcard', () => {
    const r = parseCapability('model.mutate:*');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.target?.isUniversalWildcard).toBe(true);
    }
  });

  it('parses prefix glob within a segment', () => {
    const r = parseCapability('model.mutate:Pset_*');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.target) {
      expect(r.value.target.segments).toEqual([{ kind: 'literal', value: 'Pset_*' }]);
    }
  });

  it('parses dotted target with mixed literals and globs', () => {
    const r = parseCapability('model.mutate:Pset_*.FireRating');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.target) {
      expect(r.value.target.segments).toHaveLength(2);
    }
  });

  it('parses bare-* segments', () => {
    const r = parseCapability('command.invoke:*.export');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.target) {
      expect(r.value.target.segments[0]).toEqual({ kind: 'glob' });
      expect(r.value.target.segments[1]).toEqual({ kind: 'literal', value: 'export' });
    }
  });

  it('parses each scope', () => {
    const scopes = ['model', 'viewer', 'export', 'storage', 'network', 'command', 'ui'];
    for (const s of scopes) {
      const r = parseCapability(`${s}.read`);
      expect(r.ok, `expected ${s}.read to parse`).toBe(true);
    }
  });

  it('accepts identifiers with hyphens and underscores', () => {
    const r = parseCapability('storage.local-cache');
    expect(r.ok).toBe(true);
  });
});

describe('parseCapability — error cases', () => {
  it('rejects empty string', () => {
    const r = parseCapability('');
    expect(r.ok).toBe(false);
  });

  it('rejects non-string input', () => {
    const r = parseCapability(123 as unknown as string);
    expect(r.ok).toBe(false);
  });

  it('rejects leading whitespace', () => {
    const r = parseCapability(' model.read');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe('invalid_capability');
  });

  it('rejects trailing whitespace', () => {
    const r = parseCapability('model.read ');
    expect(r.ok).toBe(false);
  });

  it('rejects missing action', () => {
    const r = parseCapability('model');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe('invalid_capability');
  });

  it('rejects unknown scope', () => {
    const r = parseCapability('foo.bar');
    expect(r.ok).toBe(false);
  });

  it('rejects colon with empty target', () => {
    const r = parseCapability('network.fetch:');
    expect(r.ok).toBe(false);
  });

  it('rejects invalid action characters', () => {
    const r = parseCapability('model.read!');
    expect(r.ok).toBe(false);
  });

  it('rejects target with empty segment', () => {
    const r = parseCapability('model.mutate:Pset..Foo');
    expect(r.ok).toBe(false);
  });

  it('rejects target with embedded glob inside literal', () => {
    const r = parseCapability('model.mutate:Pset_*Foo');
    expect(r.ok).toBe(false);
  });

  it('rejects target with invalid characters', () => {
    const r = parseCapability('network.fetch:host/path');
    expect(r.ok).toBe(false);
  });

  it('rejects target starting with dot', () => {
    const r = parseCapability('model.mutate:.Foo');
    expect(r.ok).toBe(false);
  });
});

describe('parseCapabilities (list)', () => {
  it('parses all valid items', () => {
    const r = parseCapabilities(['model.read', 'viewer.read', 'export.create:csv']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(3);
  });

  it('reports indexed errors', () => {
    const r = parseCapabilities(['model.read', 'bad', 'viewer.read']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].path).toMatch(/^\[1\]/);
    }
  });

  it('aggregates multiple errors', () => {
    const r = parseCapabilities(['foo.bar', 'baz.quux']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});
