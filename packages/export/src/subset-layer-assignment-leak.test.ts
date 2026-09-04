/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3875, the `subsetEntityIds` half: a shared `IfcPresentationLayerAssignment`
 * must not carry an EXCLUDED product's geometry into a subset export, and the
 * layer itself must still be rescued rather than silently dropped.
 *
 * `step-exporter.test.ts` pins this for `visibleOnly` (one CAD layer naming a
 * visible and a hidden wall's shape representation) against a mock store. The
 * issue names FOUR export paths, and `subsetEntityIds` is the one the
 * anonymize export ultimately writes through, so it gets its own pin — through
 * a REAL parsed fixture, per this package's "assert behaviour through a real
 * fixture" rule, which also exercises the real `byType` index
 * `collectStyleEntities` reverse-scans rather than a hand-built one.
 *
 * Scope, precisely: the subset id set is handed to `StepExporter.export`
 * directly, so what is pinned here is the EXPORT's treatment of a subset, not
 * `getSubsetEntityIds`'s choice of roots. `subset-roots.test.ts` owns the
 * latter; a regression that widened the root selection would not show up in
 * this file.
 *
 * Both defects in one fixture, because they pull in opposite directions and a
 * fix for either alone would still pass half of this file:
 *
 *  - the LEAK (confidentiality): the excluded wall's own shape representation
 *    and solid, reachable from no included root except through the shared
 *    layer, must not appear;
 *  - the DROP (silent data loss): the layer assignment itself, which nothing
 *    in the file points back at, must still be rescued for the wall that IS
 *    in the subset, and its `AssignedItems` narrowed to the surviving member
 *    rather than shipped naming a line the export never wrote.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Same helper as `subset-mode.test.ts`: every `#N` referenced in the OUTPUT
 *  that has no `#N=` defining line in it. */
function findDanglingRefs(content: string): number[] {
  const defined = new Set<number>();
  for (const m of content.matchAll(/(^|\n)#(\d+)=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const id = +m[1];
    if (!defined.has(id)) dangling.add(id);
  }
  return [...dangling].sort((a, b) => a - b);
}

/** 22-char synthetic GlobalId, deterministic and unique per `n`. */
const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

/**
 * Two walls in one storey, each with its OWN product definition shape,
 * shape representation and extruded solid, plus ONE
 * `IfcPresentationLayerAssignment` (#50) whose `AssignedItems` names both
 * walls' shape representations — the routine "one CAD layer per trade"
 * shape the issue describes.
 *
 * #31 / #32 are exclusive to Wall B: no included root reaches them once
 * Wall B is out of the subset, so their only route into the export is the
 * shared layer's forward walk.
 */
const SHARED_LAYER_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('shared-layer-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('${guid(2)}',$,'Storey A',$,$,$,$,$,$,0.);
#4=IFCWALL('${guid(4)}',$,'Wall A',$,$,$,#20,$);
#5=IFCWALL('${guid(5)}',$,'Wall B',$,$,$,#30,$);
#10=IFCRELAGGREGATES('${guid(10)}',$,$,$,#1,(#2));
#11=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(11)}',$,$,$,(#4),#2);
#12=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(12)}',$,$,$,(#5),#2);
#20=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));
#21=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#22));
#22=IFCEXTRUDEDAREASOLID(#23,#26,#27,3.);
#23=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#24);
#24=IFCPOLYLINE((#25,#28));
#25=IFCCARTESIANPOINT((0.,0.));
#26=IFCAXIS2PLACEMENT3D(#29,$,$);
#27=IFCDIRECTION((0.,0.,1.));
#28=IFCCARTESIANPOINT((1.,1.));
#29=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));
#31=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#32));
#32=IFCEXTRUDEDAREASOLID(#23,#26,#27,4.);
#50=IFCPRESENTATIONLAYERASSIGNMENT('Layer_Walls',$,(#21,#31),$);
ENDSEC;
END-ISO-10303-21;`;

describe('#3875 subsetEntityIds: a shared presentation layer assignment', () => {
  it('does not carry an excluded product’s geometry into the subset, and is still rescued for the included one', async () => {
    const store = await parse(SHARED_LAYER_MODEL);

    // Wall A's branch only. Wall B (#5) and its containment relation (#12)
    // are deliberately out; #30/#31/#32 are Wall B's exclusively.
    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      subsetEntityIds: new Set([1, 2, 4, 10, 11]),
    });
    const content = decode(result.content);

    // The subset itself, unchanged.
    expect(content).toContain('Wall A');
    expect(content).not.toContain('Wall B');

    // Defect 2 (silent data loss): the layer assignment is reachable from no
    // product root, so only the reverse rescue pass puts it in the export.
    expect(content).toContain('#50=IFCPRESENTATIONLAYERASSIGNMENT');
    // …with the INCLUDED wall's geometry chain intact behind it.
    expect(content).toContain('#21=IFCSHAPEREPRESENTATION');
    expect(content).toContain('#22=IFCEXTRUDEDAREASOLID');

    // Defect 1 (confidentiality): the excluded wall's own representation and
    // solid have no other route into this export. The rescued layer's
    // forward walk must not be that route.
    expect(content).not.toContain('#31=IFCSHAPEREPRESENTATION');
    expect(content).not.toContain('#32=IFCEXTRUDEDAREASOLID');
    expect(content).not.toContain('#30=IFCPRODUCTDEFINITIONSHAPE');

    // And the rescued line must not name what the export refused to write:
    // `AssignedItems` narrows to the surviving member, the same way an
    // `IFCREL*` list does, instead of shipping a dangling `#31`.
    const layer = content.match(/^#50=IFCPRESENTATIONLAYERASSIGNMENT\((.*)\);$/m);
    expect(layer).not.toBeNull();
    expect(layer![1]).toContain('(#21)');
    expect(layer![1]).not.toContain('#31');

    expect(findDanglingRefs(content)).toEqual([]);
  });

  // The subtype is indexed under its OWN STEP type name, so it needs its own
  // `byType` lookup in the rescue pass — a fix applied to
  // IFCPRESENTATIONLAYERASSIGNMENT alone would leave this one leaking.
  it('applies the same rule to the IFCPRESENTATIONLAYERWITHSTYLE subtype', async () => {
    const withStyle = SHARED_LAYER_MODEL.replace(
      `#50=IFCPRESENTATIONLAYERASSIGNMENT('Layer_Walls',$,(#21,#31),$);`,
      `#50=IFCPRESENTATIONLAYERWITHSTYLE('Layer_Walls',$,(#21,#31),$,.T.,.F.,.F.,(#51));\n#51=IFCCOLOURRGB($,1.,0.,0.);`,
    );
    const store = await parse(withStyle);

    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      subsetEntityIds: new Set([1, 2, 4, 10, 11]),
    });
    const content = decode(result.content);

    expect(content).toContain('#50=IFCPRESENTATIONLAYERWITHSTYLE');
    // Its LayerStyles are shared presentation RESOURCES, never owned by one
    // product, so the rescue still pulls the colour in — the narrowing is
    // aimed at product-exclusive geometry, not at the style chain.
    expect(content).toContain('#51=IFCCOLOURRGB');
    expect(content).not.toContain('#31=IFCSHAPEREPRESENTATION');
    expect(content).not.toContain('#32=IFCEXTRUDEDAREASOLID');

    const layer = content.match(/^#50=IFCPRESENTATIONLAYERWITHSTYLE\((.*)\);$/m);
    expect(layer).not.toBeNull();
    expect(layer![1]).not.toContain('#31');

    expect(findDanglingRefs(content)).toEqual([]);
  });

  /**
   * The reporting leg of #3875: a rescued entity whose own line CANNOT be
   * narrowed is withheld outright, and an entity vanishing from an export
   * must not be something the caller has to diff two files to discover.
   * `styleEntityWithheldWarning` exists for exactly that and had no test
   * reaching it, which is the shape in which a warning is quietly dead code.
   *
   * `includeGeometry: false` is the reachable case: the layer assignment is
   * still rescued (its `AssignedItems` ARE in the closure — geometry
   * exclusion is a WRITE-time decision, not a closure one), but every one of
   * those items is then omitted from the output, so narrowing leaves an
   * empty `AssignedItems` set, which is not the statement the source line
   * made. The line is withheld instead of shipped empty or dangling.
   */
  it('reports the rescued layer assignment it had to withhold rather than dropping it silently', async () => {
    const store = await parse(SHARED_LAYER_MODEL);

    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      subsetEntityIds: new Set([1, 2, 4, 10, 11]),
      includeGeometry: false,
    });
    const content = decode(result.content);

    // No geometry, so nothing is left for the layer to assign.
    expect(content).not.toContain('#21=IFCSHAPEREPRESENTATION');
    expect(content).not.toContain('#50=IFCPRESENTATIONLAYERASSIGNMENT');

    // …and the result SAYS which entity went missing, naming it and its type.
    const withheld = result.stats.warnings.filter((w) => w.includes('#50'));
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toContain('IFCPRESENTATIONLAYERASSIGNMENT');
    expect(withheld[0]).toContain('withheld');

    // Withholding is the step most able to strand a reference — the closure
    // had already accepted #50 when the write pass dropped it — so check that
    // nothing #50 named is left dangling.
    //
    // Not the blanket `toEqual([])` the other cases use: #20, Wall A's
    // IFCPRODUCTDEFINITIONSHAPE, IS dangling here, and legitimately so. A `#N`
    // named from a product's `Representation` slot is out of reach of the
    // relationship-line filter, a pre-existing `includeGeometry:false` gap
    // that `step-omission-predicates.ts` documents and measures (80 dangling
    // refs before and after, on `tests/models/AB22.ifc`). It is not this
    // test's subject, and asserting it away here would be asserting the
    // opposite of the documented position.
    const dangling = findDanglingRefs(content);
    expect(dangling).not.toContain(21);
    expect(dangling).not.toContain(31);
  });

  // Control, against over-correction: with BOTH walls in the subset nothing is
  // excluded, so the layer must keep both members and both geometry chains must
  // ship. This is the only case in this file asserting that #31/#32 DO appear
  // and that `AssignedItems` is left at full width, which is what a narrowing
  // filter that dropped refs it could not confirm — rather than only refs the
  // export actually omitted — would break.
  //
  // It does NOT catch a rescue pass that stopped following a layer's items:
  // measured, that mutation leaves this test green, because here #21/#31/#32
  // are already in the closure via the two wall roots and the layer's forward
  // walk contributes nothing. The subtype test above is what catches it, via
  // #51=IFCCOLOURRGB.
  it('control: a subset containing both walls keeps the layer’s full membership', async () => {
    const store = await parse(SHARED_LAYER_MODEL);

    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      subsetEntityIds: new Set([1, 2, 4, 5, 10, 11, 12]),
    });
    const content = decode(result.content);

    expect(content).toContain('#21=IFCSHAPEREPRESENTATION');
    expect(content).toContain('#31=IFCSHAPEREPRESENTATION');
    expect(content).toContain('#32=IFCEXTRUDEDAREASOLID');

    const layer = content.match(/^#50=IFCPRESENTATIONLAYERASSIGNMENT\((.*)\);$/m);
    expect(layer).not.toBeNull();
    expect(layer![1]).toContain('#21');
    expect(layer![1]).toContain('#31');

    expect(findDanglingRefs(content)).toEqual([]);
  });
});
