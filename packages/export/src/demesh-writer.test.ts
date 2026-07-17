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
