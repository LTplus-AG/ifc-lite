/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { diffCapabilities, requiresReconsent } from './diff.js';
import { parseCapability } from './parse.js';

function p(raw: string) {
  const r = parseCapability(raw);
  if (!r.ok) throw new Error(r.errors[0].message);
  return r.value;
}

describe('diffCapabilities', () => {
  it('empty diff for identical sets', () => {
    const set = [p('model.read'), p('viewer.read')];
    const d = diffCapabilities(set, set);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchanged.map((c) => c.raw).sort()).toEqual(['model.read', 'viewer.read']);
  });

  it('reports added capabilities', () => {
    const prev = [p('model.read')];
    const next = [p('model.read'), p('network.fetch:example.com')];
    const d = diffCapabilities(prev, next);
    expect(d.added).toHaveLength(1);
    expect(d.added[0].raw).toBe('network.fetch:example.com');
  });

  it('reports removed capabilities', () => {
    const prev = [p('model.read'), p('viewer.read')];
    const next = [p('model.read')];
    const d = diffCapabilities(prev, next);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0].raw).toBe('viewer.read');
  });

  it('distinguishes targets: model.read vs model.mutate:Pset_*', () => {
    const prev = [p('model.read')];
    const next = [p('model.mutate:Pset_*')];
    const d = diffCapabilities(prev, next);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
  });

  it('treats target narrowing as added+removed', () => {
    const prev = [p('model.mutate:*')];
    const next = [p('model.mutate:Pset_*')];
    const d = diffCapabilities(prev, next);
    expect(d.added.map((c) => c.raw)).toEqual(['model.mutate:Pset_*']);
    expect(d.removed.map((c) => c.raw)).toEqual(['model.mutate:*']);
  });
});

describe('requiresReconsent', () => {
  it('true when capabilities are added', () => {
    const d = diffCapabilities([p('model.read')], [p('model.read'), p('viewer.read')]);
    expect(requiresReconsent(d)).toBe(true);
  });

  it('false when only capabilities are removed', () => {
    const d = diffCapabilities([p('model.read'), p('viewer.read')], [p('model.read')]);
    expect(requiresReconsent(d)).toBe(false);
  });

  it('false when sets are identical', () => {
    const set = [p('model.read')];
    expect(requiresReconsent(diffCapabilities(set, set))).toBe(false);
  });
});
