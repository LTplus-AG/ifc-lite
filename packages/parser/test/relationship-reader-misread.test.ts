/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9192: the byte reader that builds the relationship graph records edges for a
 * relationship only when its related list and relating value read cleanly.
 * Before, a nested or typed value stopped `readRefList` early and the rest of
 * the list shifted into the relating slot, so `((#10),#14),#40` became an edge
 * typing #10 by the wall #14, and every graph consumer saw it. The current
 * type-quantities read trusts the graph to list every reference a record holds.
 */

import { describe, expect, it } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { readRefList } from '../src/columnar-parser-attributes.js';
import { extractPropertyRelFast, extractRelFast } from '../src/columnar-parser-relationships.js';
import { IfcParser } from '../src/index.js';

const bytes = (step: string) => new TextEncoder().encode(step);
const typing = (members: string, type: string) => {
  const buf = bytes(`#5=IFCRELDEFINESBYTYPE('g',$,$,$,${members},${type});`);
  return extractRelFast(buf, 0, buf.length, 'IFCRELDEFINESBYTYPE', 'IFC4');
};
const definition = (members: string, relating: string) => {
  const buf = bytes(`#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,${members},${relating});`);
  return extractPropertyRelFast(buf, 0, buf.length);
};
const association = (members: string, relating: string) => {
  const buf = bytes(`#5=IFCRELASSOCIATESMATERIAL('g',$,$,$,${members},${relating});`);
  return extractPropertyRelFast(buf, 0, buf.length, true);
};

describe('#9192 readRefList says where a list really ends', () => {
  it.each([
    ['(#1,#2)', 7],
    ['( #1 , /* ) */ #2 )', 19],
    ['(#1,$,#2)', 9],
    ['()', 2],
    ['#7', 2],
  ])('%s ends at %i', (value, next) => {
    const buf = bytes(value);
    expect(readRefList(buf, 0, buf.length)[2]).toBe(next);
  });

  it.each([
    ['a nested list', '((#1),#2)'],
    ['a typed value', "(#1,IFCLABEL('x'),#2)"],
    ['a missing comma', '(#1 #2)'],
    ['an empty member', '(#1,,#2)'],
    ['a trailing comma', '(#1,)'],
    ['a number', '(#1,2)'],
    ['a string', "(#1,'#2')"],
    ['an enumeration', '(#1,.T.)'],
    ['no closing parenthesis', '(#1,#2'],
    ['an unterminated comment', '(#1,/* #2)'],
    ['a reference to #0', '(#1,#0)'],
    ['a bare #0', '#0'],
    ['a bare #', '(#1,#)'],
    ['an id past the 32-bit id columns', '(#1,#4294967296)'],
  ])('%s is not a plain reference list', (_label, value) => {
    const buf = bytes(value);
    expect(readRefList(buf, 0, buf.length)[2]).toBe(-1);
  });
});

describe('#9192 extractRelFast records nothing for a record it would misread', () => {
  it.each([
    ['a nested value in RelatedObjects', '((#10),#14)', '#40'],
    ['a typed value in RelatedObjects', "(#10,IFCLABEL('x'),#14)", '#40'],
    ['a stray ) after RelatedObjects', '(#10)),#14', '#40'],
    ['a stray ) after RelatingType', '(#10),#14)', '#40'],
    ['RelatedObjects without parentheses', '#10,#11', '#40'],
    ['a value after RelatingType, the last attribute', '(#10,#11)', '#40,#41'],
    ['two entities in RelatingType', '(#10,#11)', '(#40,#41)'],
    ['members without a comma', '(#10 #11)', '#40'],
    ['a number member', '(#10,14)', '#40'],
    ['a string member', "(#10,'#14')", '#40'],
    ['an unclosed list', '(#10,#11', '#40'],
    ['a #0 member, which no entity can be', '(#10,#0)', '#40'],
    ['a bare #0 as RelatingType', '(#10,#11)', '#0'],
    ['a bare # as RelatingType', '(#10,#11)', '#'],
    ['a bare #0 as RelatedObjects', '#0', '#40'],
  ])('%s', (_label, members, type) => {
    expect(typing(members, type)).toBeNull();
  });

  it.each([
    ['a plain record', '(#10,#11)', '#40', [10, 11]],
    ['comments and line breaks', '( #10 ,\n/* ) */ #11 )', ' #40 /* c */', [10, 11]],
    ['an empty member, which no decoder reads as a reference', '(#10,$,#11)', '#40', [10, 11]],
    ['RelatingType written as a one-entity list', '(#10,#11)', '(#40)', [10, 11]],
    ['one bare related reference', '#10', '#40', [10]],
  ])('keeps %s', (_label, members, type, related) => {
    expect(typing(members, type)).toEqual({ relatingObject: 40, relatedObjects: related });
  });

  // A string attribute before the slots may hold `)`, `,` and an escaped quote.
  it('reads past an escaped ) or , in Name', () => {
    const read = (members: string) => {
      const buf = bytes(`#5=IFCRELDEFINESBYTYPE('g',$,'a),b''c,(d',$,${members},#40);`);
      return extractRelFast(buf, 0, buf.length, 'IFCRELDEFINESBYTYPE', 'IFC4');
    };
    expect(read('(#10,#11)')).toEqual({ relatingObject: 40, relatedObjects: [10, 11] });
    expect(read('((#10),#14)')).toBeNull();
  });

  it('keeps a record without its ; and one with fewer attributes than the schema declares', () => {
    const aggregates = bytes("#1=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3))");
    expect(extractRelFast(aggregates, 0, aggregates.length, 'IFCRELAGGREGATES', 'IFC4')).toEqual({ relatingObject: 1, relatedObjects: [2, 3] });
    // IfcRelSequence declares TimeLag and SequenceType after both slots; the slot is followed by `)`.
    const sequence = bytes("#1=IFCRELSEQUENCE('g',$,$,$,#1,#2);");
    expect(extractRelFast(sequence, 0, sequence.length, 'IFCRELSEQUENCE', 'IFC4')).toEqual({ relatingObject: 1, relatedObjects: [2] });
    const full = bytes("#1=IFCRELSEQUENCE('g',$,$,$,#1,#2,$,.START_START.,$);");
    expect(extractRelFast(full, 0, full.length, 'IFCRELSEQUENCE', 'IFC4')).toEqual({ relatingObject: 1, relatedObjects: [2] });
  });
});

describe('#9192 extractPropertyRelFast records nothing for a record it would misread', () => {
  it.each([
    ['a nested value in RelatedObjects', '((#20),#21,#40)', '#24'],
    ['a typed value in RelatedObjects', "(#20,IFCLABEL('x'))", '#24'],
    ['a stray ) after the definition', '(#20)', '#24),#25'],
    ['a value after the definition, the last attribute', '(#20)', '#24,#25'],
    ['RelatedObjects followed by something else', '(#20) #21', '#24'],
    // The definition is read like a related list: only references and `$`.
    ['a nested list before a definition', '(#20,$)', '((#24),#41)'],
    ['a nested list after a definition', '(#20)', '(#41,(#24))'],
    ['a typed definition set with two arguments', '(#20)', 'IFCPROPERTYSETDEFINITIONSET((#24),#41)'],
    ['a nested typed definition set', '(#20)', 'IFCPROPERTYSETDEFINITIONSET(((#24),#41))'],
    ['a string in a definition set', '(#20)', "(#24,'x')"],
    ['a string that looks like a reference', '(#20)', "('#41',#24)"],
    ['a number in a definition set', '(#20)', '(#24,41)'],
    ['an empty member in a definition set', '(#20)', '(#24,,#41)'],
    ['a #0 member in RelatedObjects', '(#20,#0)', '#24'],
    ['a #0 definition', '(#20)', '#0'],
    ['a #0 member in a definition set', '(#20)', '(#24,#0)'],
  ])('%s', (_label, members, relating) => {
    expect(definition(members, relating)).toBeNull();
  });

  // RelatingPropertyDefinition may be an IfcPropertySetDefinitionSet in IFC4 and IFC4X3.
  it.each([
    ['a single definition', '#24', [24]],
    ['a bare definition set', '(#24,#41)', [24, 41]],
    ['a typed definition set', 'IFCPROPERTYSETDEFINITIONSET((#24,#41))', [24, 41]],
    ['a typed definition set with trivia', ' IFCPROPERTYSETDEFINITIONSET /* s */ ( ( #24 , #41 ) ) ', [24, 41]],
    ['a definition set with an empty member', '(#24,$,#41)', [24, 41]],
  ])('keeps %s', (_label, relating, defs) => {
    expect(definition('(#20)', relating)).toEqual({ relatedObjects: [20], relatingDefs: defs });
  });
});

describe('#9192 an association records nothing for a record it would misread', () => {
  it.each([
    ['two entities in the relating value', '(#20)', '(#40,#41)'],
    ['one entity written twice', '(#20)', '(#40,#40)'],
    ['a nested relating value', '(#20)', '((#40))'],
    ['a string beside the relating entity', '(#20)', "(#40,'x')"],
    ['a nested value in RelatedObjects', '((#20),#21)', '#40'],
    ['a value after the relating attribute, the last one', '(#20)', '#40,#41'],
  ])('%s', (_label, members, relating) => {
    expect(association(members, relating)).toBeNull();
  });

  it.each([
    ['one reference', '#40'],
    ['a one-entity list', '(#40)'],
  ])('keeps %s', (_label, relating) => {
    expect(association('(#20,$,#21)', relating)).toEqual({ relatedObjects: [20, 21], relatingDefs: [40] });
  });
});

describe('#9192 the parsed graph has no edge for a misread record, and every other edge as before', () => {
  const file = (schema: string, lines: string[]) => {
    const text = [
      'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('t.ifc','',(''),(''),'','','');",
      `FILE_SCHEMA(('${schema}'));`, 'ENDSEC;', 'DATA;',
      "#1=IFCPROJECT('p',$,'P',$,$,$,$,$,$);",
      "#2=IFCSITE('s',$,'S',$,$,$,$,$,$,$,$,$,$,$);",
      "#3=IFCBUILDINGSTOREY('b',$,'B',$,$,$,$,$,$,$);",
      ...[10, 11, 12, 13, 14].map((id) => `#${id}=IFCWALL('w${id}',$,'W${id}',$,$,$,$,$,$);`),
      "#20=IFCWALLTYPE('t20',$,'A',$,$,$,$,$,$,.STANDARD.);",
      "#24=IFCELEMENTQUANTITY('q24',$,'Qto',$,$,());",
      "#25=IFCPROPERTYSET('p25',$,'Pset',$,());",
      "#30=IFCOPENINGELEMENT('o30',$,$,$,$,$,$,$,$);",
      "#60=IFCMATERIAL('M60',$,$);",
      "#61=IFCMATERIAL('M61',$,$);",
      ...lines, 'ENDSEC;', 'END-ISO-10303-21;',
    ].join('\n');
    const encoded = bytes(text);
    const buffer = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(buffer).set(encoded);
    return new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
  };

  // IFC2X3 has no IfcPropertySetDefinitionSet: its definitions are single references.
  const sets = {
    lines: [
      "#47=IFCRELDEFINESBYPROPERTIES('d',$,$,$,(#10),IFCPROPERTYSETDEFINITIONSET((#24,#25)));",
      "#48=IFCRELDEFINESBYPROPERTIES('d2',$,$,$,(#11),(#24,#25));",
    ],
    to10: [[24, 47], [25, 47]],
    to11: [[24, 48], [25, 48]],
  };
  const singles = {
    lines: [
      "#47=IFCRELDEFINESBYPROPERTIES('d',$,$,$,(#10),#24);",
      "#48=IFCRELDEFINESBYPROPERTIES('d2',$,$,$,(#11),#25);",
    ],
    to10: [[24, 47]],
    to11: [[25, 48]],
  };
  it.each([
    ['IFC2X3', singles],
    ['IFC4', sets],
    ['IFC4X3_ADD2', sets],
  ])('in an %s file', async (schema, definitions) => {
    const store = await file(schema, [
      "#40=IFCRELAGGREGATES('a',$,$,$,#1,(#2));",
      "#41=IFCRELAGGREGATES('a2',$,$,$,#2,(#3));",
      "#42=IFCRELCONTAINEDINSPATIALSTRUCTURE('c',$,$,$,(#10,#11),#3);",
      "#43=IFCRELCONTAINEDINSPATIALSTRUCTURE('c2',$,$,$,((#12),#13),#3);",
      "#44=IFCRELVOIDSELEMENT('v',$,$,$,#10,#30);",
      "#45=IFCRELDEFINESBYTYPE('t',$,$,$,(#10,#11),#20);",
      "#46=IFCRELDEFINESBYTYPE('t2',$,$,$,((#12),#14),#20);",
      ...definitions.lines,
      "#49=IFCRELDEFINESBYPROPERTIES('d3',$,$,$,((#12),#13),#25);",
      "#50=IFCRELDEFINESBYPROPERTIES('d4',$,$,$,(#14,$),((#24),#25));",
      "#51=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#10),#60);",
      "#52=IFCRELASSOCIATESMATERIAL('m2',$,$,$,(#13),(#60,#61));",
    ]);
    const graph = store.relationships;
    const from = (id: number, type: RelationshipType) => graph.forward.getEdges(id, type).map((edge) => [edge.target, edge.relationshipId]);
    const to = (id: number, type: RelationshipType) => graph.inverse.getEdges(id, type).map((edge) => [edge.target, edge.relationshipId]);

    expect(from(1, RelationshipType.Aggregates)).toEqual([[2, 40]]);
    expect(from(3, RelationshipType.ContainsElements)).toEqual([[10, 42], [11, 42]]);
    expect(from(10, RelationshipType.VoidsElement)).toEqual([[30, 44]]);
    expect(from(20, RelationshipType.DefinesByType)).toEqual([[10, 45], [11, 45]]);
    expect(to(10, RelationshipType.DefinesByProperties)).toEqual(definitions.to10);
    expect(to(11, RelationshipType.DefinesByProperties)).toEqual(definitions.to11);
    expect(from(60, RelationshipType.AssociatesMaterial)).toEqual([[10, 51]]);

    // The misread records name #12, #13 and #14 nowhere in the graph, rather than shifting
    // #13 or #14 into the relating slot (a wall containing, typing or defining #12), or
    // reading only part of a relating value (#25 defining #14, #60 the material of #13).
    for (const id of [12, 13, 14]) expect(graph.inverse.getEdges(id)).toEqual([]);
    for (const id of [13, 14, 61]) expect(graph.forward.getEdges(id)).toEqual([]);
    for (const id of [43, 46, 49, 50, 52]) {
      expect([...graph.forward.offsets.keys()].some((source) => graph.forward.getEdges(source).some((edge) => edge.relationshipId === id)), `#${id}`).toBe(false);
    }
    expect(store.onDemandPropertyMap?.get(12)).toBeUndefined();
    expect(store.onDemandPropertyMap?.get(14)).toBeUndefined();
    expect(store.onDemandPropertyMap?.get(11)).toEqual([25]);
    expect(store.onDemandQuantityMap?.get(10)).toEqual([24]);
    expect(store.onDemandMaterialMap?.get(10)).toEqual([60]);
    expect(store.onDemandMaterialMap?.get(13)).toBeUndefined();
  });
});
