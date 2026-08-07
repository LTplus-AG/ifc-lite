/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `satisfiesCaretRange` is the runtime gate `apps/viewer/src/services/sources/
 * source-host.ts` uses to decide whether a provider manifest is allowed to
 * register against this host (`satisfiesCaretRange(PLUGIN_API_VERSION,
 * manifest.api)`). Before this file, neither it nor `matchesGlob` had any
 * behavioural coverage in this package — a broken major-version check (e.g.
 * always returning true) passed the full test suite unchanged.
 */

import { describe, it, expect } from 'vitest';
import { satisfiesCaretRange, matchesGlob, PLUGIN_API_VERSION } from '../src/version.js';

describe('satisfiesCaretRange', () => {
  it('accepts an exact match', () => {
    expect(satisfiesCaretRange('2.0.0', '^2.0.0')).toBe(true);
  });

  it('accepts a host with a higher patch', () => {
    expect(satisfiesCaretRange('2.0.5', '^2.0.0')).toBe(true);
  });

  it('rejects a host with a lower patch', () => {
    expect(satisfiesCaretRange('2.0.0', '^2.0.5')).toBe(false);
  });

  it('accepts a host with a higher minor, regardless of patch', () => {
    expect(satisfiesCaretRange('2.5.0', '^2.1.9')).toBe(true);
  });

  it('rejects a host with a lower minor', () => {
    expect(satisfiesCaretRange('2.0.9', '^2.1.0')).toBe(false);
  });

  it('rejects a lower major, even with a much higher minor/patch', () => {
    expect(satisfiesCaretRange('1.99.99', '^2.0.0')).toBe(false);
  });

  it('rejects a higher major (caret ranges do not span majors)', () => {
    expect(satisfiesCaretRange('3.0.0', '^2.0.0')).toBe(false);
  });

  it('accepts the range without a leading caret', () => {
    expect(satisfiesCaretRange('2.0.0', '2.0.0')).toBe(true);
  });

  it('rejects a malformed required range', () => {
    expect(satisfiesCaretRange('2.0.0', '^2.x')).toBe(false);
    expect(satisfiesCaretRange('2.0.0', '')).toBe(false);
    expect(satisfiesCaretRange('2.0.0', '>=2.0.0')).toBe(false);
  });

  it('rejects a malformed host version', () => {
    expect(satisfiesCaretRange('not-a-version', '^2.0.0')).toBe(false);
    expect(satisfiesCaretRange('', '^2.0.0')).toBe(false);
  });

  it('gates the package version constant against itself, as source-host.ts does', () => {
    expect(satisfiesCaretRange(PLUGIN_API_VERSION, `^${PLUGIN_API_VERSION}`)).toBe(true);
    expect(satisfiesCaretRange(PLUGIN_API_VERSION, '^99.0.0')).toBe(false);
  });
});

describe('matchesGlob', () => {
  it('matches a literal name with no wildcards', () => {
    expect(matchesGlob('model.ifc', 'model.ifc')).toBe(true);
    expect(matchesGlob('model.ifc', 'other.ifc')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchesGlob('MODEL.IFC', 'model.ifc')).toBe(true);
  });

  it('expands * to match any run of characters', () => {
    expect(matchesGlob('model.ifc', '*.ifc')).toBe(true);
    expect(matchesGlob('model.ifczip', '*.ifc')).toBe(false);
    expect(matchesGlob('a/b/model.ifc', '*.ifc')).toBe(true);
  });

  it('expands ? to match exactly one character', () => {
    expect(matchesGlob('a.ifc', '?.ifc')).toBe(true);
    expect(matchesGlob('ab.ifc', '?.ifc')).toBe(false);
    expect(matchesGlob('.ifc', '?.ifc')).toBe(false);
  });

  it('escapes regex metacharacters in the pattern so they behave as literals', () => {
    expect(matchesGlob('plan(1).ifc', 'plan(1).ifc')).toBe(true);
    expect(matchesGlob('plan1.ifc', 'plan(1).ifc')).toBe(false);
    expect(matchesGlob('a+b.ifc', 'a+b.ifc')).toBe(true);
    expect(matchesGlob('aXb.ifc', 'a+b.ifc')).toBe(false);
  });

  it('anchors the match to the full name, not a substring', () => {
    expect(matchesGlob('prefix-model.ifc', 'model.ifc')).toBe(false);
    expect(matchesGlob('model.ifc-suffix', 'model.ifc')).toBe(false);
  });
});
