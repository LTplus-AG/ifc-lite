// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The #1891 closure verdict must describe the mesh `produce_element_meshes`
//! ACTUALLY RETURNS, not the one the hasher happened to see.
//!
//! `orient_mesh_outward_verdict` runs on the assembled body and the verdict goes
//! straight to the hasher. `build_mesh_data` runs LATER, and it runs the
//! f32-collapse degenerate backstop (`Mesh::drop_degenerate_triangles`), which
//! removes triangles. A removed triangle takes its three welded edges with it,
//! so every neighbour along those edges loses an incidence and becomes a
//! BOUNDARY edge: a shell the verdict certified closed can be handed back OPEN,
//! still carrying `0x0F` flags and a finite volume. That is precisely the
//! failure the gate exists to prevent — a volume certifying geometry that no
//! longer exists.
//!
//! The fixture is an inline `IfcFacetedBrep` NEEDLE TETRAHEDRON: four vertices,
//! two of them 0.1 mm apart while the body spans ~25 m. Two of its four faces
//! therefore have an edge-length ratio above the backstop's 1e5 aspect
//! threshold and are dropped; the other two survive. 0.1 mm is deliberately
//! above the orienter's 10 µm weld grid, so the short edge's endpoints stay
//! DISTINCT vertices and the pre-cleanup shell really is a closed, orientable,
//! single-component solid — the verdict is not wrong when it is taken, it is
//! wrong by the time it is read.

use ifc_lite_core::{build_entity_index, has_geometry_by_name, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{orient_mesh_outward_verdict, GeometryRouter, Mesh, OrientVerdict};
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, GeometryHashConfig,
    MeshProductionContext, MeshProductionOptions, ProducedElementMeshes,
};
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// A tetrahedron whose A–B edge is 0.1 mm long while every other edge is
/// ~22–25 m. Faces ACB and ABD (the two that touch A–B) have an aspect ratio of
/// ~2.2e5, above the backstop's 1e5; faces ADC and BCD are ~1.1 and survive.
/// Wound outward as authored so the shell is a valid `IfcClosedShell`.
const NEEDLE_TETRA: &str = r##"ISO-10303-21;
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
#101=IFCCARTESIANPOINT((0.0001,0.,0.));
#102=IFCCARTESIANPOINT((10.,20.,0.));
#103=IFCCARTESIANPOINT((10.,5.,20.));
#110=IFCPOLYLOOP((#100,#102,#101));
#111=IFCFACEOUTERBOUND(#110,.T.);
#112=IFCFACE((#111));
#120=IFCPOLYLOOP((#100,#101,#103));
#121=IFCFACEOUTERBOUND(#120,.T.);
#122=IFCFACE((#121));
#130=IFCPOLYLOOP((#100,#103,#102));
#131=IFCFACEOUTERBOUND(#130,.T.);
#132=IFCFACE((#131));
#140=IFCPOLYLOOP((#101,#102,#103));
#141=IFCFACEOUTERBOUND(#140,.T.);
#142=IFCFACE((#141));
#170=IFCCLOSEDSHELL((#112,#122,#132,#142));
#171=IFCFACETEDBREP(#170);
#18=IFCSHAPEREPRESENTATION(#6,'Body','Brep',(#171));
#19=IFCPRODUCTDEFINITIONSHAPE($,$,(#18));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT($,#21);
#23=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8U',$,'needle',$,$,#22,#19,$,$);
ENDSEC;
END-ISO-10303-21;
"##;

/// The control: an ordinary 1 m `IfcFacetedBrep` cube, no needle anywhere, so
/// the backstop drops nothing and the gate must still ship its volume. Without
/// this, "refuse everything" would pass the guard above.
const PLAIN_CUBE: &str = r##"ISO-10303-21;
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
#120=IFCPOLYLOOP((#104,#105,#106,#107));
#121=IFCFACEOUTERBOUND(#120,.T.);
#122=IFCFACE((#121));
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
#170=IFCCLOSEDSHELL((#112,#122,#132,#142,#152,#162));
#171=IFCFACETEDBREP(#170);
#18=IFCSHAPEREPRESENTATION(#6,'Body','Brep',(#171));
#19=IFCPRODUCTDEFINITIONSHAPE($,$,(#18));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT($,#21);
#23=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8U',$,'cube',$,$,#22,#19,$,$);
ENDSEC;
END-ISO-10303-21;
"##;

/// Run the canonical producer over every geometry-bearing entity of an inline
/// IFC, with geometry hashing ON (the native orchestrator defaults it OFF, so
/// only the direct entry point can exercise the fingerprint pass).
fn produce_all(content: &[u8]) -> Vec<(u32, ProducedElementMeshes)> {
    let index = Arc::new(build_entity_index(content));
    let router = GeometryRouter::with_scale(1.0);
    let mut decoder = EntityDecoder::with_arc_index(content, index.clone());
    decoder.seed_unit_scales(router.unit_scale(), 1.0);

    let void_index = FxHashMap::default();
    let geometry_style_index = FxHashMap::default();
    let indexed_colour_full = FxHashMap::default();
    let element_material_colors = FxHashMap::default();
    let texture_index = FxHashMap::default();
    let ctx = MeshProductionContext {
        void_index: &void_index,
        geometry_style_index: &geometry_style_index,
        indexed_colour_full: &indexed_colour_full,
        element_material_colors: &element_material_colors,
        texture_index: &texture_index,
        site_local_rotation: None,
    };
    let opts = MeshProductionOptions {
        geometry_hash: Some(GeometryHashConfig {
            tolerance: ifc_lite_geometry::DEFAULT_GEOM_HASH_TOLERANCE,
            world_rtc: [0.0; 3],
        }),
    };

    let mut jobs: Vec<(u32, usize, usize)> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if has_geometry_by_name(type_name) {
            jobs.push((id, start, end));
        }
    }

    let mut out = Vec::new();
    for (id, start, end) in jobs {
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        let ifc_type = entity.ifc_type;
        out.push((
            id,
            produce_element_meshes(
                &ElementMeshJob {
                    id,
                    ifc_type,
                    entity: &entity,
                    kind: ElementJobKind::Product,
                    element_color: None,
                    metadata: None,
                },
                &ctx,
                &opts,
                &mut decoder,
                &router,
            ),
        ));
    }
    out
}

/// The topology of what was actually RETURNED, re-derived from the emitted
/// buffers. Closedness, orientability and component count are properties of the
/// welded edge graph, so they are winding-independent — running the orienter on
/// a throwaway copy reads them off the returned mesh without depending on the
/// winding it happens to carry.
fn returned_verdict(p: &ProducedElementMeshes) -> OrientVerdict {
    assert_eq!(
        p.meshes.len(),
        1,
        "these fixtures are single-item breps; the test's re-derivation assumes one mesh"
    );
    let m = &p.meshes[0];
    let mut copy = Mesh {
        positions: m.positions.clone(),
        normals: m.normals.clone(),
        indices: m.indices.clone(),
        ..Default::default()
    };
    orient_mesh_outward_verdict(&mut copy)
}

/// The single element of an inline fixture.
fn only_element(content: &str) -> ProducedElementMeshes {
    let mut produced = produce_all(content.as_bytes());
    assert_eq!(produced.len(), 1, "fixture must hold exactly one product");
    produced.pop().unwrap().1
}

/// THE regression guard (#1891 review, PR #1993). Whatever the hasher saw, a
/// shipped volume must describe the geometry handed back — so if the closure
/// verdict claims a trustworthy solid, the RETURNED mesh has to be one.
#[test]
fn a_shipped_volume_describes_the_returned_mesh_not_the_pre_cleanup_one() {
    let p = only_element(NEEDLE_TETRA);

    // The premise: the backstop really did fire on this element, and it really
    // did open the shell. Without both, the test proves nothing.
    assert_eq!(
        p.degenerate_triangles_dropped, 2,
        "fixture premise broken: the backstop must drop exactly the two needle faces"
    );
    let actual = returned_verdict(&p);
    assert!(
        !actual.all_closed,
        "fixture premise broken: dropping the needle faces must leave an OPEN shell"
    );

    let closure = p
        .geometry_closure
        .expect("hashing is on and geometry was produced, so a verdict is owed");
    assert!(
        !closure.is_trustworthy_solid(),
        "the verdict still calls this a single closed solid ({:#06b}) after cleanup opened it",
        closure.bits()
    );
    assert!(
        p.geometry_volume.is_none(),
        "a volume ({:?}) shipped for a mesh that is no longer closed",
        p.geometry_volume
    );
}

/// The control that keeps the guard above from being satisfied by refusing
/// everything: an untouched brep still gets its volume, and the number is the
/// cube's real 1 m³.
#[test]
fn an_untouched_brep_still_ships_its_volume() {
    let p = only_element(PLAIN_CUBE);

    assert_eq!(
        p.degenerate_triangles_dropped, 0,
        "the plain cube must not trip the backstop"
    );
    assert!(
        returned_verdict(&p).is_single_closed_solid(),
        "the plain cube must come back a single closed solid"
    );
    let closure = p.geometry_closure.expect("a verdict is owed");
    assert_eq!(
        closure.bits(),
        0b1111,
        "the untouched cube must keep all four clauses"
    );
    let volume = p.geometry_volume.expect("the cube's volume must ship");
    assert!(
        (volume - 1.0).abs() < 1e-6,
        "unit cube reported {volume} m³"
    );
}
