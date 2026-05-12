/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { flagToKey, parseElementParams } from './create.js';

describe('flagToKey', () => {
  it('converts multi-word kebab-case flag to PascalCase', () => {
    expect(flagToKey('--wall-thickness')).toBe('WallThickness');
    expect(flagToKey('--overall-width')).toBe('OverallWidth');
    expect(flagToKey('--web-thickness')).toBe('WebThickness');
    expect(flagToKey('--flange-thickness')).toBe('FlangeThickness');
    expect(flagToKey('--fillet-radius')).toBe('FilletRadius');
  });

  it('converts three-word kebab-case flags', () => {
    expect(flagToKey('--number-of-risers')).toBe('NumberOfRisers');
    expect(flagToKey('--riser-height')).toBe('RiserHeight');
    expect(flagToKey('--tread-length')).toBe('TreadLength');
  });
});

describe('parseElementParams', () => {
  it('parses numeric flags', () => {
    const params = parseElementParams(['wall', '--height', '3', '--thickness', '0.2']);
    expect(params.Height).toBe(3);
    expect(params.Thickness).toBe(0.2);
  });

  it('parses string flags', () => {
    const params = parseElementParams(['wall', '--name', 'TestWall', '--description', 'A test']);
    expect(params.Name).toBe('TestWall');
    expect(params.Description).toBe('A test');
  });

  it('parses coordinate flags (comma-separated)', () => {
    const params = parseElementParams(['wall', '--start', '1,2,3', '--end', '4,5,6']);
    expect(params.Start).toEqual([1, 2, 3]);
    expect(params.End).toEqual([4, 5, 6]);
  });

  it('parses position flag', () => {
    const params = parseElementParams(['column', '--position', '10,20,0']);
    expect(params.Position).toEqual([10, 20, 0]);
  });

  it('parses boolean flag --is-rectangular', () => {
    const params = parseElementParams(['pile', '--is-rectangular']);
    expect(params.IsRectangular).toBe(true);
  });

  it('parses --wall-id as integer', () => {
    const params = parseElementParams(['wall-door', '--wall-id', '42']);
    expect(params.WallId).toBe(42);
  });

  it('returns empty params when no flags are provided', () => {
    const params = parseElementParams(['wall']);
    expect(Object.keys(params)).toHaveLength(0);
  });

  it('ignores unknown flags (non-numeric, non-string, non-coord)', () => {
    const params = parseElementParams(['wall', '--unknown', 'foo']);
    expect(params).not.toHaveProperty('Unknown');
  });

  it('parses all profile-related numeric flags', () => {
    const params = parseElementParams([
      'i-shape-beam',
      '--overall-width', '0.2',
      '--overall-depth', '0.4',
      '--web-thickness', '0.01',
      '--flange-thickness', '0.015',
      '--fillet-radius', '0.005',
    ]);
    expect(params.OverallWidth).toBe(0.2);
    expect(params.OverallDepth).toBe(0.4);
    expect(params.WebThickness).toBe(0.01);
    expect(params.FlangeThickness).toBe(0.015);
    expect(params.FilletRadius).toBe(0.005);
  });

  it('parses stair-specific flags', () => {
    const params = parseElementParams([
      'stair',
      '--number-of-risers', '12',
      '--riser-height', '0.175',
      '--tread-length', '0.28',
    ]);
    expect(params.NumberOfRisers).toBe(12);
    expect(params.RiserHeight).toBe(0.175);
    expect(params.TreadLength).toBe(0.28);
  });

  it('handles negative coordinate values', () => {
    const params = parseElementParams(['wall', '--position', '-5,-3,0']);
    expect(params.Position).toEqual([-5, -3, 0]);
  });
});
