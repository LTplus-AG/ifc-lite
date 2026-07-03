// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Source-vertex-weld guarantee (F1, formerly the export-only #1553 weld).
//!
//! The faceted-brep mesher emits geometry per `IfcFace` with no cross-face
//! vertex sharing, so coplanar sub-faces of a shell duplicate the vertices on
//! their shared edge (identical position AND identical normal). Every element
//! now passes through `build_mesh_data`, which welds those coincident vertices
//! at the single per-element funnel, so `process_geometry`'s `MeshData` arrives
//! pre-welded (which is why the per-export welds were removed).
//!
//! The fixture is an INLINE minimal IFC (a unit cube authored as an
//! `IfcFacetedBrep` whose TOP face is split into two coplanar triangles), so
//! the test runs in CI without any external fixture. The two top triangles
//! share a diagonal edge whose two endpoints carry the SAME +Z normal — the
//! per-face mesher emits them twice (26 vertices, 2 duplicate `(position,
//! normal)` keys); the source weld collapses them (24 vertices, 0 duplicates).

use ifc_lite_processing::process_geometry;
use std::collections::HashSet;

/// Minimal IFC4 faceted-brep cube. The top (z=1) face is two coplanar triangles
/// (#122 + #125) rather than one quad, so it carries the per-face duplication a
/// source weld must collapse. All other faces are quads.
const BREP_CUBE_SPLIT_TOP: &str = r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('11tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);
#100=IFCCARTESIANPOINT((0.,0.,0.));
#101=IFCCARTESIANPOINT((1.,0.,0.));
#102=IFCCARTESIANPOINT((1.,1.,0.));
#103=IFCCARTESIANPOINT((0.,1.,0.));
#104=IFCCARTESIANPOINT((0.,0.,1.));
#105=IFCCARTESIANPOINT((1.,0.,1.));
#106=IFCCARTESIANPOINT((1.,1.,1.));
#107=IFCCARTESIANPOINT((0.,1.,1.));
#110=IFCPOLYLOOP((#100,#103,#102,#101));
#111=IFCFACEOUTERBOUND(#110,.T.);
#112=IFCFACE((#111));
#120=IFCPOLYLOOP((#104,#105,#106));
#121=IFCFACEOUTERBOUND(#120,.T.);
#122=IFCFACE((#121));
#123=IFCPOLYLOOP((#104,#106,#107));
#124=IFCFACEOUTERBOUND(#123,.T.);
#125=IFCFACE((#124));
#130=IFCPOLYLOOP((#100,#101,#105,#104));
#131=IFCFACEOUTERBOUND(#130,.T.);
#132=IFCFACE((#131));
#140=IFCPOLYLOOP((#101,#102,#106,#105));
#141=IFCFACEOUTERBOUND(#140,.T.);
#142=IFCFACE((#141));
#150=IFCPOLYLOOP((#102,#103,#107,#106));
#151=IFCFACEOUTERBOUND(#150,.T.);
#152=IFCFACE((#151));
#160=IFCPOLYLOOP((#103,#100,#104,#107));
#161=IFCFACEOUTERBOUND(#160,.T.);
#162=IFCFACE((#161));
#170=IFCCLOSEDSHELL((#112,#122,#125,#132,#142,#152,#162));
#171=IFCFACETEDBREP(#170);
#18=IFCSHAPEREPRESENTATION(#6,'Body','Brep',(#171));
#19=IFCPRODUCTDEFINITIONSHAPE($,$,(#18));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT($,#21);
#23=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8U',$,'brepcube',$,$,#22,#19,$,$);
ENDSEC;
END-ISO-10303-21;
"##;

/// A vertex's weld key: exact f32 position bits + the normal quantized on the
/// same 1e3 grid `mesh_weld` uses.
fn weld_key(p: &[f32], n: &[f32], v: usize) -> (u32, u32, u32, i32, i32, i32) {
    (
        p[v * 3].to_bits(),
        p[v * 3 + 1].to_bits(),
        p[v * 3 + 2].to_bits(),
        (n[v * 3] * 1000.0).round() as i32,
        (n[v * 3 + 1] * 1000.0).round() as i32,
        (n[v * 3 + 2] * 1000.0).round() as i32,
    )
}

#[test]
fn faceted_brep_source_mesh_is_pre_welded() {
    let result = process_geometry(BREP_CUBE_SPLIT_TOP);
    assert_eq!(result.meshes.len(), 1, "expected the single brep-cube occurrence");
    let m = &result.meshes[0];

    // Invariant: no two vertices share the same (position, quantized-normal)
    // key. Without the source weld the two split-top triangles would duplicate
    // their shared-edge endpoints (2 duplicate keys); the source weld removes
    // them. This is the guarantee the removed per-export welds used to provide.
    let nv = m.positions.len() / 3;
    let mut seen: HashSet<(u32, u32, u32, i32, i32, i32)> = HashSet::new();
    let mut dups = 0;
    for v in 0..nv {
        if !seen.insert(weld_key(&m.positions, &m.normals, v)) {
            dups += 1;
        }
    }
    assert_eq!(dups, 0, "source MeshData must arrive fully welded (found {dups} duplicate keys)");

    // Flat shading preserved: a cube corner shared by 3 faces carries 3 distinct
    // normals, so it stays split — the welded box keeps 24 vertices (8 corners x
    // 3 face normals), NOT 8. The split-top triangles' 2 duplicated diagonal
    // vertices are the only ones collapsed (26 -> 24 raw face vertices).
    assert_eq!(nv, 24, "flat-shaded welded cube keeps 24 vertices, got {nv}");
    assert_eq!(m.indices.len() / 3, 12, "12 triangles unchanged by the weld");

    // Idempotence: re-welding the produced mesh is a no-op (same vertex count),
    // confirming the source already welded and the removed per-export weld would
    // have been redundant.
    assert!(
        ifc_lite_geometry::mesh_weld::weld_indexed(
            &m.positions,
            &m.normals,
            m.uvs.as_deref(),
            &m.indices,
        )
        .is_none(),
        "re-weld is a no-op (None): the source mesh already arrived welded"
    );
}
