/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { BufferEntitySource } from '../src/entity-source.js';
import type { EntityIndex } from '../src/types.js';

function makeIndex(step: string): { source: Uint8Array; index: EntityIndex } {
  const source = new TextEncoder().encode(step);
  const index: EntityIndex = {
    byId: new Map([[10, { expressId: 10, type: 'IFCWALL', byteOffset: 0, byteLength: source.length, lineNumber: 1 }]]),
    byType: new Map([['IFCWALL', [10]]]),
  };
  return { source, index };
}

describe('BufferEntitySource', () => {
  it('getEntity returns parsed entity for known expressId', () => {
    const { source, index } = makeIndex(`#10=IFCWALL('abc',$,'My Wall',$,$,$,$,.NOTDEFINED.);`);
    const src = new BufferEntitySource(source, index);
    const entity = src.getEntity(10);
    expect(entity).not.toBeNull();
    expect(entity!.expressId).toBe(10);
    expect(entity!.type).toBe('IFCWALL');
    expect(entity!.attributes[2]).toBe('My Wall');
  });

  it('getEntity returns null for unknown expressId', () => {
    const { source, index } = makeIndex(`#10=IFCWALL('abc',$,'My Wall',$,$,$,$,.NOTDEFINED.);`);
    const src = new BufferEntitySource(source, index);
    expect(src.getEntity(999)).toBeNull();
  });

  it('getEntitiesByType returns all entities of that type', () => {
    const { source, index } = makeIndex(`#10=IFCWALL('a',$,'W1',$,$,$,$,.NOTDEFINED.);`);
    const src = new BufferEntitySource(source, index);
    const walls = src.getEntitiesByType('IFCWALL');
    expect(walls).toHaveLength(1);
    expect(walls[0].expressId).toBe(10);
  });

  it('getEntitiesByType returns empty array for unknown type', () => {
    const { source, index } = makeIndex(`#10=IFCWALL('abc',$,'W',$,$,$,$,.NOTDEFINED.);`);
    const src = new BufferEntitySource(source, index);
    expect(src.getEntitiesByType('IFCBEAM')).toEqual([]);
  });
});
