/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { applySimplifiedGeometry } from './demesh-writer.js';

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Referenced `#N` tokens that have no `#N=` definition. */
function danglingRefs(text: string): number[] {
  const defined = new Set<number>();
  for (const m of text.matchAll(/(^|\n)\s*#(\d+)\s*=/g)) defined.add(+m[2]);
  const refs = new Set<number>();
  for (const m of text.matchAll(/#(\d+)/g)) refs.add(+m[1]);
  return [...refs].filter((id) => !defined.has(id)).sort((a, b) => a - b);
}

/**
 * Entity types reachable from `startId` by following `#n` references.
 *
 * Asserting that an IFCTRIANGULATEDFACESET merely EXISTS in the output would
 * also pass if #10 still pointed at its old representation and the new faceset
 * were emitted as an orphan. Reachability is what actually ties the element to
 * the geometry that replaced it.
 */
function typesReachableFrom(text: string, startId: number): Set<string> {
  const lineById = new Map<number, string>();
  for (const m of text.matchAll(/(?:^|\n)\s*#(\d+)\s*=\s*(IFC\w+)([^\n]*)/g)) {
    lineById.set(+m[1], `${m[2]}${m[3]}`);
  }
  const seen = new Set<number>();
  const types = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const line = lineById.get(id);
    if (line === undefined) continue;
    types.add(line.slice(0, line.indexOf('(')));
    for (const r of line.matchAll(/#(\d+)/g)) stack.push(+r[1]);
  }
  return types;
}

const HEADER = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#8=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#7,$,.MODEL_VIEW.,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`;

const FOOTER = `ENDSEC;
END-ISO-10303-21;`;

// Wall #10 with its own SweptSolid representation and one opening cut.
const FIXTURE_SINGLE = `${HEADER}
#10=IFCWALL('0wall10000000000000000',$,'A',$,$,$,#100,$,$);
#100=IFCPRODUCTDEFINITIONSHAPE($,$,(#110));
#110=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#120));
#120=IFCEXTRUDEDAREASOLID(#130,#131,#132,2.);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#131=IFCAXIS2PLACEMENT3D(#5,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#200=IFCOPENINGELEMENT('0open00000000000000000',$,$,$,$,$,#210,$,$);
#210=IFCPRODUCTDEFINITIONSHAPE($,$,(#211));
#211=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#212));
#212=IFCEXTRUDEDAREASOLID(#213,#131,#132,1.);
#213=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.5,0.5);
#220=IFCRELVOIDSELEMENT('0rvoid0000000000000000',$,$,$,#10,#200);
${FOOTER}`;

// FIXTURE_SINGLE plus a second (unreplaced) wall and two presentation
// layers: #400 assigns the replaced wall's solid AND the kept wall's solid,
// #401 assigns ONLY the replaced solid.
const FIXTURE_LAYERS = `${HEADER}
#10=IFCWALL('0wall10000000000000000',$,'A',$,$,$,#100,$,$);
#100=IFCPRODUCTDEFINITIONSHAPE($,$,(#110));
#110=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#120));
#120=IFCEXTRUDEDAREASOLID(#130,#131,#132,2.);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#131=IFCAXIS2PLACEMENT3D(#5,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#20=IFCWALL('0wall20000000000000000',$,'B',$,$,$,#300,$,$);
#300=IFCPRODUCTDEFINITIONSHAPE($,$,(#310));
#310=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#320));
#320=IFCEXTRUDEDAREASOLID(#130,#131,#132,3.);
#400=IFCPRESENTATIONLAYERASSIGNMENT('Layer-mixed',$,(#120,#320),$);
#401=IFCPRESENTATIONLAYERASSIGNMENT('Layer-only-old',$,(#120),$);
${FOOTER}`;

// Two walls SHARING one IfcProductDefinitionShape.
const FIXTURE_SHARED = `${HEADER}
#10=IFCWALL('0wall10000000000000000',$,'A',$,$,$,#100,$,$);
#11=IFCWALL('0wall20000000000000000',$,'B',$,$,$,#100,$,$);
#100=IFCPRODUCTDEFINITIONSHAPE($,$,(#110));
#110=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#120));
#120=IFCEXTRUDEDAREASOLID(#130,#131,#132,2.);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#131=IFCAXIS2PLACEMENT3D(#5,$,$);
#132=IFCDIRECTION((0.,0.,1.));
${FOOTER}`;

// IFC4X3-only element (IfcSignal is not in the parser's IFC4-pinned
// registry — packages/parser/src/generated/schema-registry.ts). Its
// Representation attribute sits at positional index 6, same as IfcWall's,
// but only the cross-schema union lookup (getAttributeNamesAcrossSchemas)
// can find it.
const FIXTURE_IFC4X3_SIGNAL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#8=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#7,$,.MODEL_VIEW.,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCSIGNAL('0sig10000000000000000',$,'S',$,$,$,#100,$,$);
#100=IFCPRODUCTDEFINITIONSHAPE($,$,(#110));
#110=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#120));
#120=IFCEXTRUDEDAREASOLID(#130,#131,#132,2.);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#131=IFCAXIS2PLACEMENT3D(#5,$,$);
#132=IFCDIRECTION((0.,0.,1.));
${FOOTER}`;

/** Unit tetrahedron in the element's local frame (file units). */
const TETRA = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  indices: [0, 1, 2, 0, 1, 3, 1, 2, 3, 0, 2, 3],
};

async function loadStore(text: string) {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, {
    disableWorkerScan: true,
  });
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  return { store, view, editor };
}

function exportText(store: any, view: any): string {
  return decode(
    new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content,
  );
}

describe('applySimplifiedGeometry', () => {
  it('replaces the representation with a tessellated faceset and prunes the old subgraph', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_SINGLE);
    const report = applySimplifiedGeometry(store, editor, [
      { expressId: 10, ...TETRA, color: [0.5, 0.25, 0.125, 1] },
    ]);

    expect(report.replaced).toEqual([10]);
    expect(report.skipped).toEqual([]);
    expect(report.prunedEntityCount).toBeGreaterThan(0);

    const out = exportText(store, view);

    // New tessellation chain, anchored on the Body subcontext (#8).
    expect(out).toMatch(/=IFCCARTESIANPOINTLIST3D\(\(\(0\.,0\.,0\.\),\(1\.,0\.,0\.\),\(0\.,1\.,0\.\),\(0\.,0\.,1\.\)\)\)/);
    // 1-based CoordIndex, Normals/Closed/PnIndex omitted.
    expect(out).toMatch(/=IFCTRIANGULATEDFACESET\(#\d+,\$,\$,\(\(1,2,3\),\(1,2,4\),\(2,3,4\),\(1,3,4\)\),\$\)/);
    expect(out).toMatch(/=IFCSHAPEREPRESENTATION\(#8,'Body','Tessellation',\(#\d+\)\)/);
    // Style chain from the element color, decimal reals throughout.
    expect(out).toMatch(/=IFCCOLOURRGB\(\$,0\.5,0\.25,0\.125\)/);
    expect(out).toMatch(/=IFCSURFACESTYLESHADING\(#\d+,0\.\)/);
    expect(out).toMatch(/=IFCSTYLEDITEM\(#\d+,\(#\d+\),\$\)/);

    // The wall no longer references its old shape, and the old geometry
    // subgraph is gone.
    expect(out).not.toMatch(/#10=IFCWALL\([^\n]*#100/);
    expect(out).not.toMatch(/#100=IFCPRODUCTDEFINITIONSHAPE/);
    expect(out).not.toMatch(/IFCEXTRUDEDAREASOLID/);
    expect(out).not.toMatch(/IFCRECTANGLEPROFILEDEF/);

    // Opening + void relationship stripped (the cut is baked in).
    expect(out).not.toMatch(/IFCRELVOIDSELEMENT/);
    expect(out).not.toMatch(/IFCOPENINGELEMENT/);
    expect(report.strippedOpeningCount).toBeGreaterThan(0);

    // Shared infrastructure survives: contexts, units, the shared point #5
    // (still referenced by the world coordinate system's #6).
    expect(out).toMatch(/#7=IFCGEOMETRICREPRESENTATIONCONTEXT/);
    expect(out).toMatch(/#8=IFCGEOMETRICREPRESENTATIONSUBCONTEXT/);
    expect(out).toMatch(/#5=IFCCARTESIANPOINT/);

    expect(danglingRefs(out)).toEqual([]);
  });

  it('replaces the representation on an IFC4X3-only element type (attribute index resolved across schemas)', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_IFC4X3_SIGNAL);
    const report = applySimplifiedGeometry(store, editor, [{ expressId: 10, ...TETRA }]);

    // Bug #2032: findAttrIndex used the IFC4-pinned attribute table, under
    // which IfcSignal (an IFC4X3 leaf) has zero known attributes, so the
    // Representation slot was never found and the element was silently
    // skipped with 'no-representation-attribute'.
    expect(report.skipped).toEqual([]);
    expect(report.replaced).toEqual([10]);

    const out = exportText(store, view);
    expect(out).toMatch(/IFCTRIANGULATEDFACESET/);
    // The exporter targets IFC4 in this test and downcasts the IFC4X3-only
    // IfcSignal on write (unrelated to this fix); what matters is that
    // element #10's Representation was replaced, not skipped.
    expect(out).toMatch(/#10=IFC\w+\([^\n]*#\d+/);
    expect(danglingRefs(out)).toEqual([]);

    // Write-and-reparse: `danglingRefs` only proves the text is internally
    // consistent, not that a parser can read it back. Reparsing is what shows
    // the element actually survives a round trip rather than merely appearing
    // in the output. The class is not asserted here because the IFC4 target
    // downcasts the IFC4X3-only IfcSignal on write (see above); what has to
    // survive is #10 and its replaced representation.
    const reparsed = await new IfcParser().parseColumnar(
      new TextEncoder().encode(out).buffer,
      { disableWorkerScan: true },
    );
    expect(reparsed.entityIndex.byId.has(10)).toBe(true);
    const reparsedText = reparsed.source.decodeUtf8(0, reparsed.source.byteLength);
    expect(reparsedText).toMatch(/#10=IFC\w+\([^\n]*#\d+/);

    // Follow #10's reference chain rather than asserting the faceset exists
    // somewhere: the weaker form would also pass if #10 kept its original
    // representation and the tessellation were emitted unattached.
    expect(typesReachableFrom(reparsedText, 10)).toContain('IFCTRIANGULATEDFACESET');
  });

  it('keeps openings when stripOpenings is false', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_SINGLE);
    applySimplifiedGeometry(store, editor, [{ expressId: 10, ...TETRA }], {
      stripOpenings: false,
    });
    const out = exportText(store, view);
    expect(out).toMatch(/IFCRELVOIDSELEMENT/);
    expect(out).toMatch(/#200=IFCOPENINGELEMENT/);
    expect(danglingRefs(out)).toEqual([]);
  });

  it('keeps a shared IfcProductDefinitionShape alive while only one product is replaced', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_SHARED);
    const report = applySimplifiedGeometry(store, editor, [{ expressId: 10, ...TETRA }]);
    expect(report.replaced).toEqual([10]);

    const out = exportText(store, view);
    // Wall B still uses the shared representation, so the whole old chain stays.
    expect(out).toMatch(/#11=IFCWALL\([^\n]*#100/);
    expect(out).toMatch(/#100=IFCPRODUCTDEFINITIONSHAPE/);
    expect(out).toMatch(/#120=IFCEXTRUDEDAREASOLID/);
    // Wall A points at a new tessellated shape.
    expect(out).not.toMatch(/#10=IFCWALL\([^\n]*#100/);
    expect(out).toMatch(/IFCTRIANGULATEDFACESET/);
    expect(report.prunedEntityCount).toBe(0);
    expect(danglingRefs(out)).toEqual([]);
  });

  it('prunes the shared subgraph once BOTH products are replaced', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_SHARED);
    applySimplifiedGeometry(store, editor, [
      { expressId: 10, ...TETRA },
      { expressId: 11, ...TETRA },
    ]);
    const out = exportText(store, view);
    expect(out).not.toMatch(/#100=IFCPRODUCTDEFINITIONSHAPE/);
    expect(out).not.toMatch(/IFCEXTRUDEDAREASOLID/);
    expect(danglingRefs(out)).toEqual([]);
  });

  it('dedupes surface styles across elements with the same color', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_SHARED);
    applySimplifiedGeometry(store, editor, [
      { expressId: 10, ...TETRA, color: [1, 0, 0, 1] },
      { expressId: 11, ...TETRA, color: [1, 0, 0, 1] },
    ]);
    const out = exportText(store, view);
    expect(out.match(/=IFCSURFACESTYLE\(/g)?.length).toBe(1);
    expect(out.match(/=IFCSTYLEDITEM\(/g)?.length).toBe(2);
  });

  it('skips unknown elements and invalid geometry without touching the store', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_SINGLE);
    const report = applySimplifiedGeometry(store, editor, [
      { expressId: 9999, ...TETRA },
      { expressId: 10, positions: [0, 0, 0], indices: [0, 1, 2] },
    ]);
    expect(report.replaced).toEqual([]);
    expect(report.skipped).toEqual([
      { expressId: 9999, reason: 'not-found' },
      { expressId: 10, reason: 'invalid-geometry' },
    ]);
    const out = exportText(store, view);
    expect(out).toMatch(/#100=IFCPRODUCTDEFINITIONSHAPE/);
    expect(out).not.toMatch(/IFCTRIANGULATEDFACESET/);
  });

  it('prunes geometry whose only surviving referrer is a presentation layer, and filters the layer', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_LAYERS);
    const report = applySimplifiedGeometry(store, editor, [{ expressId: 10, ...TETRA }]);
    expect(report.replaced).toEqual([10]);

    const out = exportText(store, view);
    // The replaced solid must fall even though layers #400/#401 reference it:
    // a presentation layer annotates geometry, it does not own it.
    expect(out).not.toMatch(/#120=/);
    // The mixed layer survives with ONLY the kept wall's solid...
    expect(out).toMatch(/IFCPRESENTATIONLAYERASSIGNMENT\('Layer-mixed',\$,\(#320\),\$\)/);
    // ...the old-geometry-only layer is tombstoned (empty list is invalid).
    expect(out).not.toMatch(/Layer-only-old/);
    // Shared profile/placement survive via the kept wall's solid.
    expect(out).toMatch(/#130=/);
    expect(out).toMatch(/#320=/);
  });

  it('replaces a repeated express id once and skips the duplicates (no orphaned overlay chain)', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_SINGLE);
    const report = applySimplifiedGeometry(store, editor, [
      { expressId: 10, ...TETRA },
      { expressId: 10, ...TETRA },
    ]);
    expect(report.replaced).toEqual([10]);
    expect(report.skipped).toEqual([{ expressId: 10, reason: 'duplicate-id' }]);
    // Exactly ONE authored faceset chain in the output.
    const out = exportText(store, view);
    expect(out.match(/IFCTRIANGULATEDFACESET/g)).toHaveLength(1);
    expect(out.match(/IFCCARTESIANPOINTLIST3D/g)).toHaveLength(1);
  });

  it('rejects malformed geometry (non-finite coords, trailing values) instead of rewriting it', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_SINGLE);
    const report = applySimplifiedGeometry(store, editor, [
      // NaN coordinate must not become 0. via round().
      { expressId: 10, positions: [0, 0, NaN, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: TETRA.indices },
    ]);
    expect(report.replaced).toEqual([]);
    expect(report.skipped).toEqual([{ expressId: 10, reason: 'invalid-geometry' }]);

    // Trailing coordinate / dangling index must not be floored away.
    const report2 = applySimplifiedGeometry(store, editor, [
      { expressId: 10, positions: [...TETRA.positions, 5], indices: TETRA.indices },
    ]);
    expect(report2.skipped).toEqual([{ expressId: 10, reason: 'invalid-geometry' }]);
    const report3 = applySimplifiedGeometry(store, editor, [
      { expressId: 10, positions: TETRA.positions, indices: [...TETRA.indices, 0] },
    ]);
    expect(report3.skipped).toEqual([{ expressId: 10, reason: 'invalid-geometry' }]);

    const out = exportText(store, view);
    expect(out).toMatch(/#100=IFCPRODUCTDEFINITIONSHAPE/);
    expect(out).not.toMatch(/IFCTRIANGULATEDFACESET/);
  });

  it('does not tombstone entities that are only MENTIONED inside STEP strings', async () => {
    // #100's Name says "legacy shape #300 (see #301)". #300 is a
    // referrer-less relationship: a lexical scanner that reads string
    // contents as references would pull it (and its property set #301) into
    // the prune closure and silently delete the property data.
    const fixture = `${HEADER}
#10=IFCWALL('0wall10000000000000000',$,'A',$,$,$,#100,$,$);
#100=IFCPRODUCTDEFINITIONSHAPE('legacy shape #300 (see #301)',$,(#110));
#110=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#120));
#120=IFCEXTRUDEDAREASOLID(#130,#131,#132,2.);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#131=IFCAXIS2PLACEMENT3D(#5,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#300=IFCRELDEFINESBYPROPERTIES('0rdefp0000000000000000',$,$,$,(#10),#301);
#301=IFCPROPERTYSET('0pset00000000000000000',$,'Pset_X',$,());
${FOOTER}`;
    const { store, view, editor } = await loadStore(fixture);
    const report = applySimplifiedGeometry(store, editor, [{ expressId: 10, ...TETRA }]);
    expect(report.replaced).toEqual([10]);

    const out = exportText(store, view);
    expect(out).not.toMatch(/#100=IFCPRODUCTDEFINITIONSHAPE/);
    expect(out).toMatch(/#300=IFCRELDEFINESBYPROPERTIES/);
    expect(out).toMatch(/#301=IFCPROPERTYSET/);
    expect(danglingRefs(out)).toEqual([]);
  });
});

/**
 * Three prune behaviours that no fixture above reaches. A mutation sweep left
 * the suite green on all three: deleting `IFCOWNERHISTORY` from
 * `PROTECTED_TYPES`, counting EVERY tombstone into `strippedOpeningCount`
 * (`toBeGreaterThan(0)` holds either way), and never pulling styled items into
 * the closure.
 */

// FIXTURE_SINGLE, except the opening element carries an IfcOwnerHistory that
// NOTHING else in the file references. When the opening falls, the history is
// orphaned inside the closure and only PROTECTED_TYPES keeps it alive.
const FIXTURE_ORPHANED_OWNER = `${HEADER}
#95=IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);
#10=IFCWALL('0wall10000000000000000',$,'A',$,$,$,#100,$,$);
#100=IFCPRODUCTDEFINITIONSHAPE($,$,(#110));
#110=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#120));
#120=IFCEXTRUDEDAREASOLID(#130,#131,#132,2.);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#131=IFCAXIS2PLACEMENT3D(#5,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#200=IFCOPENINGELEMENT('0open00000000000000000',#95,$,$,$,$,#210,$,$);
#210=IFCPRODUCTDEFINITIONSHAPE($,$,(#211));
#211=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#212));
#212=IFCEXTRUDEDAREASOLID(#213,#131,#132,1.);
#213=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.5,0.5);
#220=IFCRELVOIDSELEMENT('0rvoid0000000000000000',$,$,$,#10,#200);
${FOOTER}`;

// FIXTURE_SINGLE with no opening at all, plus a style chain hanging OFF the
// replaced solid (#120). IfcStyledItem points AT the geometry, so forward
// reachability from the representation root never finds it.
const FIXTURE_STYLED = `${HEADER}
#10=IFCWALL('0wall10000000000000000',$,'A',$,$,$,#100,$,$);
#100=IFCPRODUCTDEFINITIONSHAPE($,$,(#110));
#110=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',(#120));
#120=IFCEXTRUDEDAREASOLID(#130,#131,#132,2.);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#131=IFCAXIS2PLACEMENT3D(#5,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#500=IFCSTYLEDITEM(#120,(#501),$);
#501=IFCSURFACESTYLE('OldStyle',.BOTH.,(#502));
#502=IFCSURFACESTYLESHADING(#503,0.);
#503=IFCCOLOURRGB($,1.,0.,0.);
${FOOTER}`;

describe('applySimplifiedGeometry — prune edges', () => {
  it('never tombstones shared infrastructure orphaned by the sweep (IfcOwnerHistory)', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_ORPHANED_OWNER);
    const report = applySimplifiedGeometry(store, editor, [{ expressId: 10, ...TETRA }]);
    expect(report.replaced).toEqual([10]);

    const out = exportText(store, view);
    // The opening that referenced it IS gone — so this is genuinely the
    // orphaned case, not a history kept alive by a surviving referrer.
    expect(out).not.toMatch(/IFCOPENINGELEMENT/);
    expect(out).toMatch(/#95=IFCOWNERHISTORY/);
    expect(danglingRefs(out)).toEqual([]);
  });

  it('counts ONLY openings into strippedOpeningCount', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_SINGLE);
    const report = applySimplifiedGeometry(store, editor, [{ expressId: 10, ...TETRA }]);

    // Exactly the IfcRelVoidsElement (#220) and the IfcOpeningElement (#200).
    // `toBeGreaterThan(0)` is equally true of a counter that counts every
    // tombstone, which is a strictly larger number here.
    expect(report.strippedOpeningCount).toBe(2);
    expect(report.prunedEntityCount).toBeGreaterThan(report.strippedOpeningCount);
  });

  it('reports zero stripped openings for a model that has none', async () => {
    const { store, editor } = await loadStore(FIXTURE_STYLED);
    const report = applySimplifiedGeometry(store, editor, [{ expressId: 10, ...TETRA }]);
    expect(report.strippedOpeningCount).toBe(0);
    expect(report.prunedEntityCount).toBeGreaterThan(0);
  });

  it('prunes the style chain that hangs off replaced geometry, leaving no dangling item', async () => {
    const { store, view, editor } = await loadStore(FIXTURE_STYLED);
    applySimplifiedGeometry(store, editor, [{ expressId: 10, ...TETRA }]);
    const out = exportText(store, view);

    // The old solid is gone...
    expect(out).not.toMatch(/IFCEXTRUDEDAREASOLID/);
    // ...and so is the styled item that pointed at it. Matched by its own id
    // so the NEW style chain this export writes cannot satisfy the assertion.
    expect(out).not.toMatch(/#500=IFCSTYLEDITEM/);
    expect(out).not.toMatch(/'OldStyle'/);
    expect(danglingRefs(out)).toEqual([]);
  });
});
