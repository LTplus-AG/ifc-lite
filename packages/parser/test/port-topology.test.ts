/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';

// Plant topology: `IfcRelConnectsPortToElement` and `IfcRelConnectsPorts` were
// not indexed, so a distribution system parsed as a set of unrelated parts —
// the ports themselves were in the EntityTable (they are IfcProduct subtypes)
// but nothing said which element a port belonged to or what it was joined to.
//
// Neutral synthetic fixture (no real-world identifiers):
// - a pump and two pipe segments
// - four ports, one pair joined plainly, one pair joined WITH a
//   RealizingElement (the optional third attribute, which must not be read as
//   an end of the connection)
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCPUMP('pump-1',#1,'Pump P-01',$,$,$,$,$,$);
#11=IFCFLOWSEGMENT('pipe-1',#1,'Pipe R-01',$,$,$,$,$,$);
#12=IFCFLOWSEGMENT('pipe-2',#1,'Pipe R-02',$,$,$,$,$,$);
#20=IFCDISTRIBUTIONPORT('port-a',#1,'CP1',$,$,$,$,$,.NOTDEFINED.);
#21=IFCDISTRIBUTIONPORT('port-b',#1,'CP2',$,$,$,$,$,.NOTDEFINED.);
#22=IFCDISTRIBUTIONPORT('port-c',#1,'CP3',$,$,$,$,$,.NOTDEFINED.);
#23=IFCDISTRIBUTIONPORT('port-d',#1,'CP4',$,$,$,$,$,.NOTDEFINED.);
#30=IFCRELCONNECTSPORTTOELEMENT('r-1',#1,$,$,#20,#10);
#31=IFCRELCONNECTSPORTTOELEMENT('r-2',#1,$,$,#21,#11);
#32=IFCRELCONNECTSPORTTOELEMENT('r-3',#1,$,$,#22,#11);
#33=IFCRELCONNECTSPORTTOELEMENT('r-4',#1,$,$,#23,#12);
#40=IFCRELCONNECTSPORTS('r-5',#1,$,$,#20,#21,$);
#41=IFCRELCONNECTSPORTS('r-6',#1,$,$,#22,#23,#11);`;

async function parse() {
  const source = new TextEncoder().encode(IFC);
  const tokenizer = new StepTokenizer(source);
  const entityRefs = Array.from(tokenizer.scanEntitiesFast()).map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0), entityRefs, {});
}

describe('port topology', () => {
  it('links a port to the element it sits on, in both directions', async () => {
    const store = await parse();
    const rels = store.relationships;

    // Forward follows the EXPRESS order: RelatingPort → RelatedElement.
    expect(rels.getRelated(20, RelationshipType.ConnectsPortToElement, 'forward')).toEqual([10]);
    // Inverse is the one a caller actually wants: give me this element's ports.
    expect(
      rels.getRelated(11, RelationshipType.ConnectsPortToElement, 'inverse').sort((a, b) => a - b),
    ).toEqual([21, 22]);
  });

  it('links port to port', async () => {
    const store = await parse();
    const rels = store.relationships;

    expect(rels.getRelated(20, RelationshipType.ConnectsPorts, 'forward')).toEqual([21]);
    expect(rels.getRelated(21, RelationshipType.ConnectsPorts, 'inverse')).toEqual([20]);
  });

  it('ignores RealizingElement — a connection has two ends, not three', async () => {
    const store = await parse();
    const rels = store.relationships;

    // #41 names #11 as the element realising the connection. The edge is
    // still port-to-port; reading the optional third attribute as an end
    // would invent a connection between a port and a pipe.
    expect(rels.getRelated(22, RelationshipType.ConnectsPorts, 'forward')).toEqual([23]);
    expect(rels.getRelated(11, RelationshipType.ConnectsPorts, 'forward')).toEqual([]);
    expect(rels.getRelated(11, RelationshipType.ConnectsPorts, 'inverse')).toEqual([]);
  });

  it('makes a plant walkable end to end: element → ports → ports → elements', async () => {
    const store = await parse();
    const rels = store.relationships;

    // The whole reason both relationships are needed. From the pump, reach
    // what it is connected to without knowing anything about ports.
    const reached = new Set<number>();
    for (const port of rels.getRelated(10, RelationshipType.ConnectsPortToElement, 'inverse')) {
      const opposite = [
        ...rels.getRelated(port, RelationshipType.ConnectsPorts, 'forward'),
        ...rels.getRelated(port, RelationshipType.ConnectsPorts, 'inverse'),
      ];
      for (const other of opposite) {
        for (const element of rels.getRelated(other, RelationshipType.ConnectsPortToElement, 'forward')) {
          reached.add(element);
        }
      }
    }
    expect([...reached]).toEqual([11]);
  });

  it('keeps the ports themselves addressable, so an edge can be drawn', async () => {
    const store = await parse();
    // An id the store cannot type is one a consumer has to skip; ports are
    // IfcProduct subtypes and must survive parsing with their name intact.
    expect(store.entities.getTypeName(20)).toBe('IfcDistributionPort');
    expect(store.entities.getName(20)).toBe('CP1');
  });
});
