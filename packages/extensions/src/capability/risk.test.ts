/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseCapability } from './parse.js';
import { computeRisk, computeRisks, overallTier } from './risk.js';

function p(raw: string) {
  const r = parseCapability(raw);
  if (!r.ok) throw new Error(r.errors[0].message);
  return r.value;
}

describe('computeRisk', () => {
  it('green: model.read', () => {
    expect(computeRisk(p('model.read')).tier).toBe('green');
  });

  it('green: viewer.colorize', () => {
    expect(computeRisk(p('viewer.colorize')).tier).toBe('green');
  });

  it('green: storage.local', () => {
    expect(computeRisk(p('storage.local')).tier).toBe('green');
  });

  it('yellow: model.create', () => {
    expect(computeRisk(p('model.create')).tier).toBe('yellow');
  });

  it('yellow: model.mutate with specific target', () => {
    expect(computeRisk(p('model.mutate:Pset_WallCommon.FireRating')).tier).toBe('yellow');
  });

  it('red: model.mutate universal wildcard', () => {
    expect(computeRisk(p('model.mutate:*')).tier).toBe('red');
  });

  it('red: model.delete', () => {
    expect(computeRisk(p('model.delete')).tier).toBe('red');
  });

  it('yellow: network.fetch with single host', () => {
    expect(computeRisk(p('network.fetch:bsdd.example.com')).tier).toBe('yellow');
  });

  it('red: network.fetch with wildcard host', () => {
    expect(computeRisk(p('network.fetch:*.example.com')).tier).toBe('red');
  });

  it('red: network.fetch with universal wildcard', () => {
    expect(computeRisk(p('network.fetch:*')).tier).toBe('red');
  });

  it('red: unknown capability', () => {
    const r = computeRisk({
      raw: 'unknown.action',
      scope: 'model' as const,
      action: 'doesnotexist',
    });
    expect(r.tier).toBe('red');
  });

  it('includes the target in description', () => {
    const r = computeRisk(p('network.fetch:example.com'));
    expect(r.description).toContain('example.com');
  });
});

describe('computeRisks / overallTier', () => {
  it('overall green when all green', () => {
    const risks = computeRisks([p('model.read'), p('viewer.colorize')]);
    expect(overallTier(risks)).toBe('green');
  });

  it('overall yellow with at least one yellow', () => {
    const risks = computeRisks([p('model.read'), p('model.create')]);
    expect(overallTier(risks)).toBe('yellow');
  });

  it('overall red wins over yellow', () => {
    const risks = computeRisks([p('model.create'), p('model.delete')]);
    expect(overallTier(risks)).toBe('red');
  });

  it('empty list is green', () => {
    expect(overallTier([])).toBe('green');
  });
});
