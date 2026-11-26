/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11591: an IfcProject whose UnitsInContext is `$` read as SI defaults on the
 * source path but threw "context is unset" on the native (view-backed) path,
 * so callers with a mutation view saw "unavailable" for a project that simply
 * declares no units. Both paths must answer the same.
 */
import { describe, it, expect } from 'vitest';
import { extractProjectUnits, ProjectUnitReadError } from './project-units.js';
import { EntityExtractor } from './entity-extractor.js';
import type { EntityIndex, EntityRef } from './types.js';

function indexIfc(content: string): { source: Uint8Array; entityIndex: EntityIndex } {
  const source = new TextEncoder().encode(content);
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;
  let lineNumber = 0;
  for (const line of content.split('\n')) {
    lineNumber += 1;
    const m = /^#(\d+)=([A-Z0-9_]+)\(/.exec(line);
    if (m) {
      const expressId = Number(m[1]);
      byId.set(expressId, { expressId, type: m[2], byteOffset: offset, byteLength: line.length, lineNumber });
      byType.set(m[2], [...(byType.get(m[2]) ?? []), expressId]);
    }
    offset += line.length + 1; // ASCII fixture
  }
  return { source, entityIndex: { byId, byType } };
}

/** The strict native reader: every entity must resolve, as the view-backed path requires. */
function nativeReader(source: Uint8Array, entityIndex: EntityIndex) {
  const extractor = new EntityExtractor(source);
  return (id: number) => {
    const ref = entityIndex.byId.get(id);
    const entity = ref ? extractor.extractEntity(ref) : null;
    if (!entity) throw new ProjectUnitReadError(`#${id} is unreadable`);
    return { type: entity.type, attributes: entity.attributes };
  };
}

describe('an unset IfcProject.UnitsInContext (#11591)', () => {
  const { source, entityIndex } = indexIfc("#1=IFCPROJECT('0xScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);");

  it('reads as SI defaults on the native path, the same as the source path', () => {
    const native = extractProjectUnits(source, entityIndex, 1, nativeReader(source, entityIndex));
    const fromSource = extractProjectUnits(source, entityIndex);
    expect(native.declaredCount).toBe(0);
    expect(native.unitForMeasure('IfcLengthMeasure')).toEqual(fromSource.unitForMeasure('IfcLengthMeasure'));
    expect(native.unitForMeasure('IfcAreaMeasure')?.siScale).toBe(1);
  });

  it('still refuses a UnitsInContext that points at something unreadable', () => {
    const broken = indexIfc("#1=IFCPROJECT('0xScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,#9);");
    expect(() => extractProjectUnits(broken.source, broken.entityIndex, 1, nativeReader(broken.source, broken.entityIndex)))
      .toThrow(ProjectUnitReadError);
  });
});
