// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5313 must not scramble #858's per-triangle colours.
//!
//! `split_mesh_by_indexed_colour` maps output triangle `i` to
//! `IfcIndexedColourMap.ColourIndex[i]` and trusts a matching triangle count
//! as proof that the order survived. The T-junction repair drops a sliver and
//! splits the triangle across it, which can keep the count while shifting
//! every triangle in between. This face set is built so it does exactly that:
//! 4 triangles in, 1 sliver dropped, 1 triangle split into 2, 4 out.
//!
//! Triangle 0 is the sliver and is the only red one. If the router repaired
//! this face set, the count would match and the palette split would paint the
//! first half of triangle 1 red. With the order kept, hygiene only drops the
//! sliver (3 triangles), the count no longer matches the colour map, and the
//! splitter declines, exactly as before #5313.

use ifc_lite_processing::process_geometry;

const COLOURED_T_JUNCTION: &str = r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('3oUQ6pZ9L1Gg8m0Hxv2Kc1',$,'p',$,$,$,$,(#5),#2);
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.5,0.000005,0.),(0.5,-1.,0.),(0.5,1.,1.)));
#11=IFCTRIANGULATEDFACESET(#10,$,$,((1,2,3),(2,1,4),(1,3,5),(3,2,5)),$);
#12=IFCCOLOURRGBLIST(((1.,0.,0.),(0.,1.,0.),(0.,0.,1.),(1.,1.,0.)));
#13=IFCINDEXEDCOLOURMAP(#11,$,#12,(1,2,3,4));
#20=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#11));
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#20));
#22=IFCLOCALPLACEMENT($,#4);
#23=IFCBUILDINGELEMENTPROXY('0Kq3v8hTr4XBYw2eQm5sLp',$,'coloured',$,$,#22,#21,$,$);
ENDSEC;
END-ISO-10303-21;
"##;

#[test]
fn sliver_repair_keeps_indexed_colours_on_their_triangles() {
    let result = process_geometry(COLOURED_T_JUNCTION);
    let meshes: Vec<_> = result.meshes.iter().filter(|m| m.express_id == 23).collect();
    let tris: Vec<usize> = meshes.iter().map(|m| m.indices.len() / 3).collect();
    assert_eq!(
        tris,
        vec![3],
        "a colour-mapped face set must keep its triangle order: expected the sliver \
         dropped and no palette split, got meshes of {tris:?} triangles"
    );
}

/// A single-colour map is never palette-split (#1807), so it needs no order
/// guard: the face set gets the T-junction repair like any other (4 triangles
/// out: the sliver dropped, the triangle across it split in two).
#[test]
fn single_colour_map_still_gets_the_repair() {
    let one_colour = COLOURED_T_JUNCTION.replace("(1,2,3,4));", "(1,1,1,1));");
    let result = process_geometry(&one_colour);
    let tris: usize =
        result.meshes.iter().filter(|m| m.express_id == 23).map(|m| m.indices.len() / 3).sum();
    assert_eq!(tris, 4, "single-colour face set should be repaired, got {tris} triangles");
}
