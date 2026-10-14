/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: `'Para \S\' 5'` is ONE STEP string literal reading "Para § 5" — the
 * PAGE directive `\S\` takes the apostrophe as its operand. Every export walker
 * that splits, rewrites or scans STEP text used to end the literal at that
 * operand, so the rest of the record was read with the quote state inverted:
 * a `#9` in the text became a reference, the real reference after it became
 * text, commas inside strings became slot boundaries, and numbers in text got
 * rescaled. Each test runs one walker over a record carrying such a literal.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { remapEntityText } from './merged-remap.js';
import { collectRefsInByteRange } from './reference-collector.js';
import { argRefs, classifyRefs } from './merged-empty-containers-refs.js';
import {
  readStepSlots,
  replaceStepArgument,
  splitTopLevelListItems,
  splitTopLevelStepArguments,
} from './step-argument-parser.js';
import { isWellFormedStepSlot } from './step-slot-grammar.js';
import { findOuterArgs } from './step-outer-args.js';
import { referencesAnyExpressId } from './step-ref-scan.js';
import { scaleNumberLiterals, scaleTypedMeasures } from './unit-normalize.js';
import { createSourceRefReader } from './source-ref-bounds.js';
import {
  getElementQuantityName,
  getPropertySetName,
  resolveOwnerHistoryRef,
  type PropertySetContext,
} from './step-property-set-readers.js';
import type { EffectiveEntityIndex } from './effective-index.js';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';

const RECORD = String.raw`#3=IFCWALL('g',#2,'Para \S\' #9 5',$,#4);`;

const VECTORS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url)), 'utf8'),
) as Array<{ name: string; literal: string }>;

/** A source buffer of `#id=…;` lines, indexed the way the parser indexes them. */
function storeOf(lines: Array<[number, string, string]>): IfcDataStore {
  const encoder = new TextEncoder();
  const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
  const byType = new Map<string, number[]>();
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (const [id, type, text] of lines) {
    const encoded = encoder.encode(text);
    byId.set(id, { expressId: id, type, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    byType.set(type, [...(byType.get(type) ?? []), id]);
    parts.push(encoded);
    offset += encoded.byteLength;
  }
  const source = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    source.set(part, at);
    at += part.byteLength;
  }
  return {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: lines.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
}

describe('reference walkers keep a PAGE operand inside its string (#7589)', () => {
  it('remapEntityText leaves #9 in the text and remaps the reference after it', () => {
    expect(remapEntityText(RECORD, 10, new Map())).toBe(String.raw`#13=IFCWALL('g',#12,'Para \S\' #9 5',$,#14);`);
  });

  it('collectRefsInByteRange and argRefs find the reference after the literal, not the one in it', () => {
    const bytes = new TextEncoder().encode(RECORD);
    expect(collectRefsInByteRange(bytes, 0, bytes.length)).toEqual([3, 2, 4]);
    expect(argRefs(RECORD)).toEqual([2, 4]);
    expect(classifyRefs(String.raw`#9=IFCRELAGGREGATES('g',$,'Para \S\' #7 5',$,#4,(#5,#6));`))
      .toEqual([[4, false], [5, false], [6, false]]);
  });

  it('referencesAnyExpressId reads #9 in the text as text', () => {
    const attrs = String.raw`'g',#2,'Para \S\' #9 5',$,#4`;
    expect(referencesAnyExpressId(attrs, new Set([9]))).toBe(false);
    expect(referencesAnyExpressId(attrs, new Set([4]))).toBe(true);
  });
});

describe('slot splitters keep a PAGE operand inside its string (#7589)', () => {
  it('splitTopLevelStepArguments reads every shared PAGE vector as one slot', () => {
    for (const { name, literal } of VECTORS) {
      expect(splitTopLevelStepArguments(`${literal},#7`), name).toEqual([literal, '#7']);
    }
  });

  it('readStepSlots and replaceStepArgument address the slot after the literal', () => {
    const line = String.raw`#1=IFCWALL('g',#2,'Para \S\' 5',IFCLABEL('Art \S\' 7'),#4);`;
    expect(readStepSlots(line)?.slots).toEqual(["'g'", '#2', String.raw`'Para \S\' 5'`, String.raw`IFCLABEL('Art \S\' 7')`, '#4']);
    expect(replaceStepArgument(line, 4, '#40')).toBe(String.raw`#1=IFCWALL('g',#2,'Para \S\' 5',IFCLABEL('Art \S\' 7'),#40);`);
    expect(isWellFormedStepSlot(String.raw`'Para \S\' 5'`)).toBe(true);
  });

  it('splitTopLevelListItems keeps the literal whole', () => {
    expect(splitTopLevelListItems(String.raw`'Para \S\' 5',#7,'Art \S\' 7'`))
      .toEqual([String.raw`'Para \S\' 5'`, '#7', String.raw`'Art \S\' 7'`]);
  });

  it('findOuterArgs does not close the list at a paren inside the literal', () => {
    const line = String.raw`#1=IFCWALL('Para \S\') 5',#2);`;
    expect(findOuterArgs(line)).toEqual({ open: 10, close: line.length - 2 });
  });
});

describe('unit normalization leaves PAGE-operand text alone (#7589)', () => {
  it('scaleNumberLiterals scales the number after the literal, not the one in it', () => {
    expect(scaleNumberLiterals(String.raw`'Para \S\' 5',3.`, 1000)).toBe(String.raw`'Para \S\' 5',3000.`);
  });

  it('scaleTypedMeasures scales the measure after the literal, not the one in it', () => {
    expect(scaleTypedMeasures(String.raw`'Art \S\' IFCLENGTHMEASURE(5.)',IFCLENGTHMEASURE(2.)`, 1000, 1, 1))
      .toBe(String.raw`'Art \S\' IFCLENGTHMEASURE(5.)',IFCLENGTHMEASURE(2000.)`);
  });
});

describe('property-set readers read a PAGE-operand literal whole (#7589)', () => {
  const dataStore = storeOf([
    [5, 'IFCPROPERTYSET', String.raw`#5=IFCPROPERTYSET('g',#42,'Para \S\' 5',$,(#7));`],
    [6, 'IFCELEMENTQUANTITY', String.raw`#6=IFCELEMENTQUANTITY('g',#42,'Art \S\' 7',$,$,(#7));`],
    [8, 'IFCWALL', String.raw`#8=IFCWALL('Para \S\' 5',#42,$,$,$,$,$,$);`],
  ]);
  const unused = (): never => { throw new Error('not reachable from a line reader'); };
  const ctx: PropertySetContext = {
    dataStore,
    entityExtractor: null,
    mutationView: null,
    isReadableSourceRef: createSourceRefReader(dataStore.source),
    allocateExpressId: unused,
    ownerHistory: { fallbackRef: undefined, byEntity: new Map() },
    applySourceLineMutations: unused,
  };

  it('reads the set name to the literal end', () => {
    expect(getPropertySetName(ctx, 5)).toBe(String.raw`Para \S\' 5`);
    expect(getElementQuantityName(ctx, 6)).toBe(String.raw`Art \S\' 7`);
  });

  it('finds the owner history after a PAGE-operand GlobalId', () => {
    const effective = { typeOf: (id: number) => (id === 42 ? 'IFCOWNERHISTORY' : undefined) } as unknown as EffectiveEntityIndex;
    expect(resolveOwnerHistoryRef(ctx, 8, () => true, effective)).toBe('#42');
  });
});

describe('merged spatial matching reads a PAGE-operand name (#7589)', () => {
  it('unifies two storeys by a name carrying a PAGE operand', () => {
    const model = (id: string, guid: string, elevation: string): MergeModelInput => ({
      id,
      name: id,
      dataStore: storeOf([
        [1, 'IFCPROJECT', `#1=IFCPROJECT('p${id}',$,'P',$,$,$,$,$,$);`],
        [2, 'IFCBUILDINGSTOREY', String.raw`#2=IFCBUILDINGSTOREY('${guid}',$,'Level \S\' 1',$,$,$,$,$,.ELEMENT.,${elevation});`],
      ]),
    });
    const result = new MergedExporter([model('m1', 'g2', '0.'), model('m2', 'g4', '3000.')])
      .export({ schema: 'IFC4', projectStrategy: 'keep-first', mergeStoreys: 'by-name' });
    const content = new TextDecoder().decode(result.content);
    expect(content.match(/=IFCBUILDINGSTOREY\(/g)?.length).toBe(1);
  });
});
