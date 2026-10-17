/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7791 item 4 / D26: the storey ObjectPlacement-Z fallback promotes a 2D
 * Location to z = 0, as the Rust leaf reader does, instead of reporting no
 * elevation.
 */

import { describe, expect, it } from 'vitest';
import type { EntityRef } from './types.js';
import { extractPlacementElevation } from './spatial-hierarchy-attributes.js';

function model(point: string): { raw: Uint8Array; entityIndex: { byId: Map<number, EntityRef> } } {
  const lines = [
    `#1=IFCBUILDINGSTOREY('0000000000000000000000',$,'L1',$,$,#2,$,$,.ELEMENT.,$);`,
    `#2=IFCLOCALPLACEMENT($,#3);`,
    `#3=IFCAXIS2PLACEMENT3D(#4,$,$);`,
    `#4=IFCCARTESIANPOINT(${point});`,
  ];
  const encoder = new TextEncoder();
  const byId = new Map<number, EntityRef>();
  const parts: Uint8Array[] = [];
  let offset = 0;
  lines.forEach((line, i) => {
    const encoded = encoder.encode(line);
    const expressId = i + 1;
    const type = /=(\w+)/.exec(line)![1]!;
    byId.set(expressId, { expressId, type, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: i + 1 });
    parts.push(encoded, encoder.encode('\n'));
    offset += encoded.byteLength + 1;
  });
  const raw = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    raw.set(part, pos);
    pos += part.byteLength;
  }
  return { raw, entityIndex: { byId } };
}

describe('extractPlacementElevation', () => {
  it('reads Z of a 3D Location', () => {
    const { raw, entityIndex } = model('(1.,2.,3.5)');
    expect(extractPlacementElevation(1, raw, entityIndex)).toBe(3.5);
  });

  it('promotes a 2D Location to z = 0 (D26)', () => {
    const { raw, entityIndex } = model('(1.,2.)');
    expect(extractPlacementElevation(1, raw, entityIndex)).toBe(0);
  });

  it('rejects a point that is not 2 or 3 numbers', () => {
    const one = model('(1.)');
    expect(extractPlacementElevation(1, one.raw, one.entityIndex)).toBeUndefined();
    const { raw, entityIndex } = model('(1.,2.,3.,4.)');
    expect(extractPlacementElevation(1, raw, entityIndex)).toBeUndefined();
  });
});
