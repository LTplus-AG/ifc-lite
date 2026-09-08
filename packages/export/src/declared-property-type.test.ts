/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2482, through a REAL EXPORT: editing one
 * property in a property set regenerated the whole set from `PropertyValueType`
 * alone and re-declared every OTHER property in it — `IFCTEXT` as `IFCLABEL`,
 * `IFCLENGTHMEASURE` as `IFCREAL`.
 *
 * Every case here parses a file, drives `StepExporter` over it and reads the
 * emitted lines back. That is the whole point of them: the load-bearing case is
 * the first one below, and it asserts the emitted line of a property the session
 * never touched. That assertion cannot pass vacuously — the property is only in
 * the file at all BECAUSE the set was regenerated, so a generator that ignores
 * `dataType` writes a line that is present, correct in its value, and wrong in
 * exactly the way #2482 describes.
 *
 * The gate itself — which source tokens `declaredNominalValueType` writes back,
 * and which it refuses — is a pure predicate over the schema registry with no
 * parser, no view and no exporter in it. It fails for different reasons than
 * these do and is read while thinking about a different thing, so it lives next
 * door in `declared-nominal-value-type.test.ts`. Neither file imports anything
 * the other needs.
 */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const WALL_ID = 8;

/**
 * One property set holding one property per declared-type family the extractor
 * can produce, plus a vendor token that is not an `IfcValue` member at all.
 */
const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#50=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuQ',$,'Pset_Mixed',$,(#51,#52,#53,#54,#55,#56,#57));
#51=IFCPROPERTYSINGLEVALUE('Notes',$,IFCTEXT('a long prose value'),$);
#52=IFCPROPERTYSINGLEVALUE('Ref',$,IFCIDENTIFIER('A-01'),$);
#53=IFCPROPERTYSINGLEVALUE('Length',$,IFCLENGTHMEASURE(2500.),$);
#54=IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(12.5),$);
#55=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#56=IFCPROPERTYSINGLEVALUE('Leaves',$,IFCCOUNTMEASURE(3.),$);
#57=IFCPROPERTYSINGLEVALUE('Vendor',$,IFCACMEWIDGETCODE('X'),$);
#58=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuR',$,$,$,(#8),#50);
ENDSEC;
END-ISO-10303-21;`;

/** One property per CONSTRAINED `IfcValue` member, each holding a value its
 *  WHERE rule allows. Every one of the six is here — the table in
 *  `declared-property-type.ts` claims to be closed, so the test that says so
 *  must exercise all of it. */
const CONSTRAINED_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#50=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuQ',$,'Pset_Constrained',$,(#51,#52,#53,#54,#55,#56));
#51=IFCPROPERTYSINGLEVALUE('Thickness',$,IFCPOSITIVELENGTHMEASURE(5.),$);
#52=IFCPROPERTYSINGLEVALUE('Clearance',$,IFCNONNEGATIVELENGTHMEASURE(4.),$);
#53=IFCPROPERTYSINGLEVALUE('Ratio',$,IFCNORMALISEDRATIOMEASURE(0.5),$);
#54=IFCPROPERTYSINGLEVALUE('Scale',$,IFCPOSITIVERATIOMEASURE(2.),$);
#55=IFCPROPERTYSINGLEVALUE('Slope',$,IFCPOSITIVEPLANEANGLEMEASURE(0.4),$);
#56=IFCPROPERTYSINGLEVALUE('Leaves',$,IFCPOSITIVEINTEGER(3),$);
#58=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuR',$,$,$,(#8),#50);
ENDSEC;
END-ISO-10303-21;`;

/** A bounded property: a measure `dataType` over a DISPLAY STRING value. */
const BOUNDED_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#50=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuQ',$,'Pset_Bounded',$,(#51));
#51=IFCPROPERTYBOUNDEDVALUE('Span',$,IFCLENGTHMEASURE(20.),IFCLENGTHMEASURE(1.),$,IFCLENGTHMEASURE(12.5));
#58=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuR',$,$,$,(#8),#50);
ENDSEC;
END-ISO-10303-21;`;

async function parse(source: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(source)));
}

/** A session over `source` with the property base wired, as every real
 *  view-building site wires it. */
function sourceBackedView(store: IfcDataStore): MutablePropertyView {
  const view = new MutablePropertyView(null, 'test-model');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return view;
}

function exportText(store: IfcDataStore, view: MutablePropertyView): string {
  return new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);
}

describe('a regeneration leaves its neighbours’ declared types alone', () => {
  it('every property the session did NOT touch keeps the type its source line declared', async () => {
    const store = await parse(BASE_IFC);
    const view = sourceBackedView(store);
    // ONE edit, to a property that is not any of the ones asserted below.
    // Adding a property to an existing pset regenerates that pset wholesale,
    // which is what puts the untouched neighbours back through the serializer.
    view.setProperty(WALL_ID, 'Pset_Mixed', 'Mark', 'W-01', PropertyValueType.Label);

    const text = exportText(store, view);

    // The two string families the extractor collapses into `String`. Their
    // declared type survives ONLY in `dataType`.
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Notes',$,IFCTEXT('a long prose value'),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Ref',$,IFCIDENTIFIER('A-01'),$)");
    // The numeric families, where the measure token IS the unit semantics:
    // re-declaring a length as a plain REAL loses what the number measures.
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Length',$,IFCLENGTHMEASURE(2500.),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(12.5),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$)");
    // A NUMBER-based member: read back as an Integer, written back as the
    // measure the file declared rather than as `IFCINTEGER`.
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Leaves',$,IFCCOUNTMEASURE(3.),$)");

    // Said as the damage rather than the repair: none of the four downgrades
    // #2482 names is in the file.
    expect(text).not.toContain("IFCLABEL('a long prose value')");
    expect(text).not.toContain("IFCLABEL('A-01')");
    expect(text).not.toContain('IFCREAL(2500.)');
    expect(text).not.toContain('IFCREAL(12.5)');
  });

  it('control: the property the session DID author is written as it was authored', async () => {
    const store = await parse(BASE_IFC);
    const view = sourceBackedView(store);
    view.setProperty(WALL_ID, 'Pset_Mixed', 'Mark', 'W-01', PropertyValueType.Label);

    // A new property has no source line and therefore no `dataType` — it must
    // still land, from the type the caller named. Without this the test above
    // is satisfied by a generator that writes nothing new at all.
    expect(exportText(store, view)).toContain("IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('W-01'),$)");
  });

  it('an EDIT within the same family keeps the source measure', async () => {
    const store = await parse(BASE_IFC);
    const view = sourceBackedView(store);
    view.setProperty(WALL_ID, 'Pset_Mixed', 'Length', 3000, PropertyValueType.Real);

    // The edited property is the one case where `type` and `dataType` come from
    // different places. They agree here, so the more specific one wins: an edit
    // to a length is still a length.
    expect(exportText(store, view)).toContain(
      "IFCPROPERTYSINGLEVALUE('Length',$,IFCLENGTHMEASURE(3000.),$)",
    );
  });

  it('an EDIT that names a different family retypes the property, as asked', async () => {
    const store = await parse(BASE_IFC);
    const view = sourceBackedView(store);
    // Deliberately retyping a source length to a label. The session is explicit
    // and wins; the source token is dropped rather than wrapped around a value
    // it cannot hold.
    view.setProperty(WALL_ID, 'Pset_Mixed', 'Length', 'about 2.5m', PropertyValueType.Label);

    const text = exportText(store, view);
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Length',$,IFCLABEL('about 2.5m'),$)");
    expect(text).not.toContain('IFCLENGTHMEASURE');
  });

  it('a token that is not an IfcValue member is NOT written back', async () => {
    const store = await parse(BASE_IFC);
    const view = sourceBackedView(store);
    view.setProperty(WALL_ID, 'Pset_Mixed', 'Mark', 'W-01', PropertyValueType.Label);

    // `IFCACMEWIDGETCODE` parses, survives extraction and reaches the generator
    // in `dataType` like any other token. `NominalValue` is declared as
    // `IfcValue`, so writing it back would put a non-member in a SELECT slot —
    // faithful to the input and invalid. The lossy-but-valid fallback wins.
    const text = exportText(store, view);
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Vendor',$,IFCLABEL('X'),$)");
    expect(text).not.toContain('IFCACMEWIDGETCODE');
  });

  it('a BOUNDED property’s measure dataType is not wrapped around its display string', async () => {
    const store = await parse(BOUNDED_IFC);
    const view = sourceBackedView(store);
    view.setProperty(WALL_ID, 'Pset_Bounded', 'Mark', 'W-01', PropertyValueType.Label);

    // An `IfcPropertyBoundedValue` is extracted as a measure `dataType` over a
    // DISPLAY string (`'12.5 [1 – 20]'`) and a `Real` shape — the one place
    // where the two disagree about a source property nobody edited. Collapsing
    // such a property to a single value is lossy and older than this change
    // (#2482 calls the multi-valued kinds a separate question); what must not
    // happen is `IFCLENGTHMEASURE('12.5 [1 – 20]')`, a measure holding prose.
    const text = exportText(store, view);
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Span',$,$,$)");
    expect(text).not.toContain('IFCLENGTHMEASURE');
  });
});

describe('a constrained declared type is not reused for a value it cannot hold', () => {
  it('an edit that violates the WHERE rule relaxes to the unconstrained ancestor', async () => {
    const store = await parse(CONSTRAINED_IFC);
    const view = sourceBackedView(store);
    // `setProperty` performs no schema validation, so each of these is exactly
    // what a session can hand the exporter. Before, the base test alone passed
    // and the file said `IFCPOSITIVELENGTHMEASURE(-1.)`.
    view.setProperty(WALL_ID, 'Pset_Constrained', 'Thickness', -1, PropertyValueType.Real);
    view.setProperty(WALL_ID, 'Pset_Constrained', 'Clearance', -0.5, PropertyValueType.Real);
    view.setProperty(WALL_ID, 'Pset_Constrained', 'Ratio', 2, PropertyValueType.Real);
    view.setProperty(WALL_ID, 'Pset_Constrained', 'Scale', 0, PropertyValueType.Real);
    view.setProperty(WALL_ID, 'Pset_Constrained', 'Slope', -0.4, PropertyValueType.Real);
    view.setProperty(WALL_ID, 'Pset_Constrained', 'Leaves', 0, PropertyValueType.Integer);

    const text = exportText(store, view);

    // Schema-valid AND still a measure: the unit semantics #2482 exists to keep
    // survive the relaxation, which dropping to `IFCREAL` would have thrown away
    // on exactly the properties whose value went out of range.
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Thickness',$,IFCLENGTHMEASURE(-1.),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Clearance',$,IFCLENGTHMEASURE(-0.5),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Ratio',$,IFCRATIOMEASURE(2.),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Scale',$,IFCRATIOMEASURE(0.),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Slope',$,IFCPLANEANGLEMEASURE(-0.4),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Leaves',$,IFCINTEGER(0),$)");

    // Said as the damage: not one constrained token is left in the file holding
    // a value outside its domain.
    for (const token of [
      'IFCPOSITIVELENGTHMEASURE',
      'IFCNONNEGATIVELENGTHMEASURE',
      'IFCNORMALISEDRATIOMEASURE',
      'IFCPOSITIVERATIOMEASURE',
      'IFCPOSITIVEPLANEANGLEMEASURE',
      'IFCPOSITIVEINTEGER',
    ]) {
      expect(text).not.toContain(token);
    }
  });

  it('control: a value the WHERE rule ALLOWS keeps the constrained type', async () => {
    const store = await parse(CONSTRAINED_IFC);
    const view = sourceBackedView(store);
    // One in-range edit; the other five are untouched neighbours regenerated by
    // it. Without this the test above is satisfied by a gate that refuses every
    // constrained member outright — which would re-inflict #2482 on the entire
    // constrained half of `IfcValue`.
    view.setProperty(WALL_ID, 'Pset_Constrained', 'Thickness', 7.5, PropertyValueType.Real);

    const text = exportText(store, view);

    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Thickness',$,IFCPOSITIVELENGTHMEASURE(7.5),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Clearance',$,IFCNONNEGATIVELENGTHMEASURE(4.),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Ratio',$,IFCNORMALISEDRATIOMEASURE(0.5),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Scale',$,IFCPOSITIVERATIOMEASURE(2.),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Slope',$,IFCPOSITIVEPLANEANGLEMEASURE(0.4),$)");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Leaves',$,IFCPOSITIVEINTEGER(3),$)");
  });
});
