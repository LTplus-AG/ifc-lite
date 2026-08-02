/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for the on-demand attribute fallback in EntityNode.
 *
 * `getOnDemandAttributes()` resolves GlobalId/Name/Description/ObjectType/Tag
 * by schema-mapped attribute *name*, not fixed index. The fixed indices
 * `[0],[2],[3],[4],[7]` only describe the IfcElement layout — for an IfcSite
 * `attrs[7]` is LongName, so positional extraction would leak LongName into
 * `tag`. This asserts the schema-correct behaviour for a non-IfcElement entity.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import { EntityNode } from '../src/entity-node.js';

async function parseFixture(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: Array<{
    expressId: number;
    type: string;
    byteOffset: number;
    byteLength: number;
    lineNumber: number;
  }> = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0), entityRefs, {});
}

describe('EntityNode on-demand attribute layout', () => {
  const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCSITE('site-guid',#1,'Site Name','Site Desc','SiteObjType',$,$,'My Long Name',.ELEMENT.,$,$,$,$,$);`;

  it('does not report an IfcSite LongName as its Tag', async () => {
    const store = await parseFixture(ifc);
    const site = new EntityNode(store as never, 10);

    // `tag` always uses the on-demand path; IfcSite has no Tag attribute, so
    // it must be empty rather than the LongName sitting at attribute index 7.
    expect(site.tag).toBe('');
    expect(site.globalId).toBe('site-guid');
    expect(site.name).toBe('Site Name');
    expect(site.description).toBe('Site Desc');
    expect(site.objectType).toBe('SiteObjType');
  });
});
