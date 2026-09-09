/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4125: the two source-line writers in this package that set a STEP attribute
 * BY INDEX must refuse a record whose argument list does not scan into slots,
 * and must SAY they refused.
 *
 * The record below is what an authoring tool emits when it forgets to double an
 * apostrophe, twice. Two undoubled apostrophes leave quote parity even and
 * paren depth at zero, so nothing structural notices: the permissive splitter
 * returns seven parts for a nine-attribute class, with `IFCLABEL('a's'),$,
 * IFCLABEL('b's')` folded into one. Every case here is paired with the SAME
 * record with its apostrophes doubled, so a green result cannot come from the
 * writers having stopped writing.
 */
import { describe, it, expect } from 'vitest';
import { ENTITIES_IFC4 } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { applySourceLineMutations } from './step-attribute-mutations.js';
import { retypeStepLine } from './retype.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';

/** Nine attributes, two of them carrying an undoubled apostrophe. */
const PHANTOM = "#1=IFCWALL('g',$,IFCLABEL('a's'),$,IFCLABEL('b's'),#5,#6,'T',.SOLIDWALL.);";
/** The same record, apostrophes doubled: the control. */
const CONTROL = "#1=IFCWALL('g',$,IFCLABEL('a''s'),$,IFCLABEL('b''s'),#5,#6,'T',.SOLIDWALL.);";

/**
 * The two overlay lookups `applySourceLineMutations` makes, and nothing else.
 *
 * A `Pick` of the real class rather than a hand-written shape, so both
 * signatures stay checked against it; the widening back to
 * `MutablePropertyView` is the only unchecked step, and it is sound here
 * because the function under test guards each call with `typeof … ===
 * 'function'` and reaches no other member.
 */
type OverlayStub = Pick<
  MutablePropertyView,
  'getEntityTypeMutation' | 'getPositionalMutationsForEntity'
>;

function viewWith(
  typeMutation: ReturnType<MutablePropertyView['getEntityTypeMutation']>,
  positionals: ReturnType<MutablePropertyView['getPositionalMutationsForEntity']>,
): MutablePropertyView {
  const stub: OverlayStub = {
    getEntityTypeMutation: () => typeMutation,
    getPositionalMutationsForEntity: () => positionals,
  };
  return stub as MutablePropertyView;
}

/**
 * Run the pipeline over one record with only the edits a case actually asks
 * for.
 *
 * `overlayActive` is DERIVED from the view rather than passed beside it. In the
 * exporter the two are one fact -- there is a view exactly when the overlay is
 * active -- so a case that set them apart by hand would be exercising a state
 * the exporter cannot produce, and the seventh positional argument is the easy
 * one to get wrong.
 */
function runPipeline(args: {
  record: string;
  attributes?: Map<string, string>;
  typeMutation?: ReturnType<MutablePropertyView['getEntityTypeMutation']>;
  positionals?: ReturnType<MutablePropertyView['getPositionalMutationsForEntity']>;
}) {
  const typeMutation = args.typeMutation ?? null;
  const positionals = args.positionals ?? null;
  const view =
    typeMutation === null && positionals === null ? null : viewWith(typeMutation, positionals);
  return applySourceLineMutations(
    view,
    1,
    args.record,
    'IFCWALL',
    args.attributes,
    'IFC4',
    view !== null,
  );
}

describe('applySourceLineMutations refuses a record whose slots do not scan', () => {
  it('a named attribute edit does not land on a different attribute', () => {
    // `Description` is slot 3. On the permissive split, slot 3 of the SEVEN
    // parts is `#5` -- the record's real `ObjectPlacement` -- so the edit
    // overwrote a placement reference with a string and reported success.
    const result = runPipeline({
      record: PHANTOM,
      attributes: new Map([['Description', 'NEWDESC']]),
    });
    expect(result.text).toBe(PHANTOM);
    expect(result.attributed).toBe(false);
    expect(result.unreadable).toBe(true);
    expect(result.text).not.toContain('NEWDESC');
    expect(result.text).toContain('#5');
  });

  it('the control record with doubled apostrophes still takes the edit', () => {
    const result = runPipeline({
      record: CONTROL,
      attributes: new Map([['Description', 'NEWDESC']]),
    });
    expect(result.attributed).toBe(true);
    expect(result.unreadable).toBe(false);
    expect(result.text).toBe(
      "#1=IFCWALL('g',$,IFCLABEL('a''s'),'NEWDESC',IFCLABEL('b''s'),#5,#6,'T',.SOLIDWALL.);",
    );
  });

  it('a positional edit does not land on a different slot', () => {
    const result = runPipeline({ record: PHANTOM, positionals: new Map([[3, 'NEWDESC']]) });
    expect(result.text).toBe(PHANTOM);
    expect(result.positional).toBe(false);
    expect(result.unreadable).toBe(true);
  });

  it('the control record still takes the positional edit', () => {
    const result = runPipeline({ record: CONTROL, positionals: new Map([[3, 'NEWDESC']]) });
    expect(result.positional).toBe(true);
    expect(result.unreadable).toBe(false);
  });

  it('a record nobody edited is not reported as a refusal', () => {
    // `unreadable` is a claim about an edit that was asked for and dropped. A
    // malformed record this export merely copies has refused nothing, and
    // warning about it would be noise in every file that has one.
    const result = runPipeline({ record: PHANTOM });
    expect(result.text).toBe(PHANTOM);
    expect(result.unreadable).toBe(false);
  });
});

describe('retypeStepLine refuses a record whose slots do not scan', () => {
  it('does not emit more attributes than the target class declares', () => {
    // Before the fix this returned
    // `#1=IFCWALLSTANDARDCASE('g',$,IFCLABEL('a's'),$,IFCLABEL('b's'),#5,#6,'T',.SOLIDWALL.,$,$);`
    // -- ELEVEN top-level arguments for a nine-attribute class, because one of
    // the seven parts it re-laid-out still carried two commas of its own.
    const out = retypeStepLine(PHANTOM, 'IFCWALL', 'IFCWALLSTANDARDCASE', null, 'IFC4');
    expect(out).toBe(PHANTOM);
  });

  it('the control record still retypes, to the target class\'s own attribute count', () => {
    const out = retypeStepLine(CONTROL, 'IFCWALL', 'IFCWALLSTANDARDCASE', null, 'IFC4');
    expect(out.startsWith('#1=IFCWALLSTANDARDCASE(')).toBe(true);
    expect(out).not.toBe(CONTROL);
    // The count is read off the schema rather than typed in, so this cannot
    // outlive a registry change while still claiming to check it.
    const slots = splitTopLevelStepArguments(out.slice(out.indexOf('(') + 1, out.lastIndexOf(');')));
    expect(slots).not.toBeNull();
    expect(slots).toHaveLength(
      ENTITIES_IFC4.find((e) => e.name.toUpperCase() === 'IFCWALLSTANDARDCASE')!.attributes.length,
    );
  });

  it('the pipeline reports the refused retype rather than a silent no-op', () => {
    const result = runPipeline({
      record: PHANTOM,
      typeMutation: { newType: 'IFCWALLSTANDARDCASE', predefinedType: null },
    });
    expect(result.text).toBe(PHANTOM);
    expect(result.retyped).toBe(false);
    expect(result.unreadable).toBe(true);
  });
});
