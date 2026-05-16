/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { filterAgainstInstalled } from './filter.js';
import type { MinedPattern } from './types.js';

function pattern(seq: MinedPattern['sequence']): MinedPattern {
  return {
    sequence: seq,
    occurrences: 5,
    sessionsTouched: 2,
    lastSeenAt: '2026-05-01T00:00:00.000Z',
    score: 0,
  };
}

describe('filterAgainstInstalled', () => {
  it('passes through patterns when nothing installed', () => {
    const p = [pattern(['model.load', 'export.run'])];
    expect(filterAgainstInstalled(p, [])).toHaveLength(1);
  });

  it('drops patterns fully covered by one extension', () => {
    const p = [pattern(['model.load', 'export.run'])];
    const installed = [{ id: 'ext.a', grantedCapabilities: ['model.read', 'export.create:csv'] }];
    expect(filterAgainstInstalled(p, installed)).toHaveLength(0);
  });

  it('keeps patterns when only partially covered', () => {
    const p = [pattern(['model.load', 'lens.apply', 'export.run'])];
    const installed = [{ id: 'ext.a', grantedCapabilities: ['export.create:csv'] }];
    expect(filterAgainstInstalled(p, installed)).toHaveLength(1);
  });

  it('handles export wildcard capability', () => {
    const p = [pattern(['export.run'])];
    const installed = [{ id: 'ext.a', grantedCapabilities: ['export.create:*'] }];
    expect(filterAgainstInstalled(p, installed)).toHaveLength(0);
  });
});
