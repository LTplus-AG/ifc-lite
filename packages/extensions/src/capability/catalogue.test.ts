/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The capability catalogue is the public-facing list the review screen
 * and the authoring prompt render — adding to it is a SemVer-relevant
 * API change. Before this file `isKnownCapability` had exactly two
 * repo-wide occurrences (its definition and the barrel re-export):
 * published, and never called by a test. Replacing its body with
 * `return true` left all 603 tests green, which is precisely the
 * "unknown capability is red" story `risk.ts` leans on.
 */

import { describe, expect, it } from 'vitest';
import {
  findCatalogueEntry,
  isKnownCapability,
  listCapabilityCatalogue,
} from './catalogue.js';
import { parseCapability } from './parse.js';
import type { Capability, CapabilityScope } from '../types.js';

function cap(raw: string): Capability {
  const r = parseCapability(raw);
  if (!r.ok) throw new Error(`fixture "${raw}" does not parse: ${r.errors[0]?.message}`);
  return r.value;
}

describe('listCapabilityCatalogue', () => {
  it('returns entries and every one is well-formed', () => {
    const entries = listCapabilityCatalogue();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e.scope).toBe('string');
      expect(e.action.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(['green', 'yellow', 'red']).toContain(e.baseRisk);
      expect(typeof e.requiresTarget).toBe('boolean');
    }
  });

  it('has no duplicate scope.action keys', () => {
    const keys = listCapabilityCatalogue().map((e) => `${e.scope}.${e.action}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('isKnownCapability', () => {
  // Measured per case, not as one "some entry matches" assertion: a
  // single lucky row would otherwise carry the whole list.
  it.each([
    'model.read', 'model.mutate:Pset_*', 'model.create', 'model.delete',
    'viewer.read', 'viewer.colorize', 'viewer.isolate', 'viewer.fly', 'viewer.section',
    'export.create:csv', 'storage.local', 'network.fetch:example.invalid',
    'command.invoke:ext.*', 'ui.dock', 'ui.toolbar', 'ui.contextMenu', 'ui.statusBar',
  ])('recognises the catalogued capability "%s"', (raw) => {
    expect(isKnownCapability(cap(raw))).toBe(true);
  });

  it.each([
    ['model', 'destroy'],
    ['viewer', 'mutate'],
    ['export', 'read'],
    ['storage', 'remote'],
    ['network', 'listen'],
    ['command', 'define'],
    ['ui', 'overlay'],
  ])('rejects the uncatalogued capability "%s.%s"', (scope, action) => {
    expect(isKnownCapability({ raw: `${scope}.${action}`, scope: scope as CapabilityScope, action })).toBe(false);
  });

  it('does not resolve keys inherited from Object.prototype', () => {
    // The lookup key is built from caller-controlled strings; a plain
    // object lookup would resolve `constructor` / `toString`.
    expect(isKnownCapability({ raw: 'model.constructor', scope: 'model', action: 'constructor' })).toBe(false);
    expect(isKnownCapability({ raw: 'model.toString', scope: 'model', action: 'toString' })).toBe(false);
  });
});

describe('findCatalogueEntry', () => {
  it('returns the entry matching scope + action, ignoring the target', () => {
    const entry = findCatalogueEntry(cap('model.mutate:Pset_WallCommon.FireRating'));
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe('model');
    expect(entry?.action).toBe('mutate');
    expect(entry?.requiresTarget).toBe(true);
  });

  it('returns undefined for a capability outside the catalogue', () => {
    expect(findCatalogueEntry({ raw: 'model.destroy', scope: 'model', action: 'destroy' })).toBeUndefined();
  });

  it('agrees with isKnownCapability on every catalogued entry', () => {
    for (const e of listCapabilityCatalogue()) {
      const c = { raw: `${e.scope}.${e.action}`, scope: e.scope, action: e.action };
      expect(isKnownCapability(c)).toBe(true);
      expect(findCatalogueEntry(c)).toBe(e);
    }
  });

  it('marks exactly the target-taking capabilities as requiresTarget', () => {
    const required = listCapabilityCatalogue()
      .filter((e) => e.requiresTarget)
      .map((e) => `${e.scope}.${e.action}`)
      .sort();
    expect(required).toEqual([
      'command.invoke',
      'export.create',
      'model.mutate',
      'network.fetch',
    ]);
  });

  it('keeps model.delete and network.fetch at the red base risk', () => {
    expect(findCatalogueEntry(cap('model.delete'))?.baseRisk).toBe('red');
    expect(findCatalogueEntry(cap('network.fetch:example.invalid'))?.baseRisk).toBe('red');
  });
});
