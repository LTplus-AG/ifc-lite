/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  getFlag,
  getAllFlags,
  hasFlag,
  getPositionalArgs,
  formatTable,
  validateViewerPort,
} from './output.js';

describe('getFlag', () => {
  it('returns value for a present flag', () => {
    expect(getFlag(['--type', 'IfcWall', '--limit', '10'], '--type')).toBe('IfcWall');
    expect(getFlag(['--type', 'IfcWall', '--limit', '10'], '--limit')).toBe('10');
  });

  it('returns undefined for a missing flag', () => {
    expect(getFlag(['--type', 'IfcWall'], '--limit')).toBeUndefined();
  });

  it('returns undefined when flag is last arg (no value follows)', () => {
    expect(getFlag(['--type'], '--type')).toBeUndefined();
  });

  it('returns the first occurrence when flag is repeated', () => {
    expect(getFlag(['--set', 'A', '--set', 'B'], '--set')).toBe('A');
  });

  it('handles flag value that looks like a flag', () => {
    // getFlag just takes the next positional token regardless
    expect(getFlag(['--out', '--verbose'], '--out')).toBe('--verbose');
  });
});

describe('getAllFlags', () => {
  it('collects all values for a repeated flag', () => {
    expect(getAllFlags(['--set', 'A', '--set', 'B', '--set', 'C'], '--set')).toEqual(['A', 'B', 'C']);
  });

  it('returns empty array when flag is absent', () => {
    expect(getAllFlags(['--type', 'IfcWall'], '--set')).toEqual([]);
  });

  it('skips flag at end without a value', () => {
    expect(getAllFlags(['--set', 'A', '--set'], '--set')).toEqual(['A']);
  });

  it('handles interleaved flags correctly', () => {
    expect(getAllFlags(['--set', 'X', '--other', 'Y', '--set', 'Z'], '--set')).toEqual(['X', 'Z']);
  });
});

describe('hasFlag', () => {
  it('returns true when flag is present', () => {
    expect(hasFlag(['--json', '--verbose'], '--json')).toBe(true);
  });

  it('returns false when flag is absent', () => {
    expect(hasFlag(['--json'], '--verbose')).toBe(false);
  });

  it('does not match partial flag names', () => {
    expect(hasFlag(['--json-output'], '--json')).toBe(false);
  });
});

describe('getPositionalArgs', () => {
  it('extracts non-flag arguments', () => {
    expect(getPositionalArgs(['model.ifc', '--type', 'IfcWall', '--json'])).toEqual(['model.ifc']);
  });

  it('returns all args when there are no flags', () => {
    expect(getPositionalArgs(['file1.ifc', 'file2.ifc'])).toEqual(['file1.ifc', 'file2.ifc']);
  });

  it('returns empty array when all args are flags', () => {
    expect(getPositionalArgs(['--json', '--verbose'])).toEqual([]);
  });

  it('skips flag values (next arg after a flag)', () => {
    expect(getPositionalArgs(['input.ifc', '--out', 'output.ifc'])).toEqual(['input.ifc']);
  });

  it('handles --no- flags without consuming next arg', () => {
    // --no- flags are boolean, they should not consume the next positional arg
    expect(getPositionalArgs(['input.ifc', '--no-header', 'extra.ifc'])).toEqual(['input.ifc', 'extra.ifc']);
  });

  it('handles flag at end of args list', () => {
    expect(getPositionalArgs(['input.ifc', '--json'])).toEqual(['input.ifc']);
  });
});

describe('validateViewerPort', () => {
  it('returns undefined for undefined input', () => {
    expect(validateViewerPort(undefined)).toBeUndefined();
  });

  it('returns a valid port number', () => {
    expect(validateViewerPort('3000')).toBe(3000);
    expect(validateViewerPort('1')).toBe(1);
    expect(validateViewerPort('65535')).toBe(65535);
    expect(validateViewerPort('8080')).toBe(8080);
  });

  it('calls fatal for port 0', () => {
    expect(() => validateViewerPort('0')).toThrow();
  });

  it('calls fatal for port above 65535', () => {
    expect(() => validateViewerPort('70000')).toThrow();
  });

  it('calls fatal for negative port', () => {
    expect(() => validateViewerPort('-1')).toThrow();
  });

  it('calls fatal for non-numeric input', () => {
    expect(() => validateViewerPort('abc')).toThrow();
  });

  it('calls fatal for empty string', () => {
    expect(() => validateViewerPort('')).toThrow();
  });

  it('parses integer portion from floating point string', () => {
    // parseInt('3.5', 10) returns 3, which is valid
    expect(validateViewerPort('3.5')).toBe(3);
  });
});

describe('formatTable', () => {
  it('formats a basic table with headers and rows', () => {
    const result = formatTable(['Name', 'Type'], [['Wall-1', 'IfcWall'], ['Slab-1', 'IfcSlab']]);
    const lines = result.split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    expect(lines[0]).toContain('Name');
    expect(lines[0]).toContain('Type');
    expect(lines[2]).toContain('Wall-1');
    expect(lines[2]).toContain('IfcWall');
    expect(lines[3]).toContain('Slab-1');
    expect(lines[3]).toContain('IfcSlab');
  });

  it('handles empty rows', () => {
    const result = formatTable(['Col1', 'Col2'], []);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2); // header + separator only
  });

  it('truncates cells exceeding 60 characters', () => {
    const longString = 'A'.repeat(80);
    const result = formatTable(['Name'], [[longString]]);
    const lines = result.split('\n');
    // The cell content should be sliced to at most 60 chars
    const dataLine = lines[2];
    // The actual cell text within the row should be at most 60 chars
    expect(dataLine.length).toBeLessThanOrEqual(64); // 60 + padding/borders
  });

  it('handles missing cells in rows gracefully', () => {
    // Row has fewer cells than headers
    const result = formatTable(['A', 'B', 'C'], [['x']]);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
    // Should not throw, missing cells default to empty string
    expect(lines[2]).toContain('x');
  });

});
