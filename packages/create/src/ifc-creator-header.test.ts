/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ProjectParams.FileName` / `FileDescription` set the STEP header's
 * `FILE_NAME.name` and `FILE_DESCRIPTION.description`. Without them the header
 * stays byte-identical to the previous fixed output.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, parseSourceHeader } from '@ifc-lite/parser';
import { IfcCreator } from './ifc-creator.js';
import type { ProjectParams } from './types.js';

function header(params: ProjectParams = {}): string {
  const creator = new IfcCreator({ Timestamp: Date.UTC(2026, 10, 7, 10), ...params });
  const content = creator.toIfc().content;
  return content.slice(0, content.indexOf('ENDSEC;'));
}

describe('IfcCreator STEP header file name and description', () => {
  it('keeps the previous header when neither option is given', () => {
    const h = header();
    expect(h).toContain("FILE_DESCRIPTION(('Created by ifc-lite'),'2;1');");
    expect(h).toContain("FILE_NAME('created.ifc','2026-11-07T10:00:00',(''),(''),'ifc-lite','ifc-lite','');");
  });

  it('writes a custom file name and a single description', () => {
    const h = header({ FileName: 'tiny-house.ifc', FileDescription: 'Course model' });
    expect(h).toContain("FILE_DESCRIPTION(('Course model'),'2;1');");
    expect(h).toContain("FILE_NAME('tiny-house.ifc','2026-11-07T10:00:00',");
  });

  it('writes one list entry per description string', () => {
    const h = header({ FileDescription: ['ViewDefinition [ReferenceView]', 'Generated test model'] });
    expect(h).toContain("FILE_DESCRIPTION(('ViewDefinition [ReferenceView]','Generated test model'),'2;1');");
  });

  it('escapes apostrophes and backslashes in both values', () => {
    const h = header({ FileName: "Louis's model.ifc", FileDescription: ['C:\\models'] });
    expect(h).toContain("FILE_NAME('Louis''s model.ifc',");
    expect(h).toContain("FILE_DESCRIPTION(('C:\\\\models'),'2;1');");
  });

  it('rejects an empty description list and over-long strings', () => {
    expect(() => header({ FileDescription: [] })).toThrow(RangeError);
    expect(() => header({ FileName: 'x'.repeat(257) })).toThrow(/at most 256/);
    expect(() => header({ FileDescription: ['ok', 'y'.repeat(257)] })).toThrow(/FileDescription\[1\]/);
  });

  it('reads back through the parser with the given values', async () => {
    const creator = new IfcCreator({ Timestamp: 0, FileName: 'tiny-house.ifc', FileDescription: ['A', 'B'] });
    const bytes = new TextEncoder().encode(creator.toIfc().content);
    const parsed = parseSourceHeader(bytes);
    expect(parsed?.name).toBe('tiny-house.ifc');
    expect(parsed?.description).toEqual(['A', 'B']);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
    expect(store.entityIndex.byId.size).toBeGreaterThan(0);
  });
});
