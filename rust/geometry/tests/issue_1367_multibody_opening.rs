// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! End-to-end coverage for issue #1367 — a SINGLE `IfcOpeningElement` whose body
//! holds a ROW of spatially-separate void solids (a window strip authored as one
//! opening with many bodies) must cut EVERY hole.
//!
//! The reported defect: the void router merged all bodies of a high-vertex
//! opening into one cutter and subtracted them in a single arrangement, which on
//! the reporter's faceted-brep window bodies left diagonal "bridge" triangles
//! spanning 3 of 12 holes. `classify_openings` now splits an opening into per-
//! body cutters when its bodies form >= 2 disjoint spatial clusters, so each
//! window is cut on its own — while a void merely SPLIT into touching parts (one
//! window's inner/outer wall-leaf halves) still subtracts merged (see the
//! `spatial_cluster_count` unit tests and the FZK-Haus gable watertightness
//! tests for the two routing directions).
//!
//! This fixture is synthetic (no third-party model data): one straight wall and
//! one opening carrying `N_WINDOWS` separate box voids, sized so the opening's
//! combined mesh clears the `vertex_count > 100` high-vertex guard — i.e. it
//! exercises the per-body-cluster split path and asserts the wall ends up with
//! all `N_WINDOWS` holes (no body lost, the wall not emptied or over-cut).
//! Faithfully reproducing the *bridge* needs the reporter's faceted-brep
//! geometry, which can't be checked in; clean box voids cut cleanly either way.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const WALL_ID: u32 = 50;
const N_WINDOWS: usize = 12;
const WALL_FRONT_Y: f64 = 0.05; // wall is 0.1 m thick, centred on Y=0
const WIN_PITCH: f64 = 0.7; // centre-to-centre spacing (0.2 m solid pillars)
const WIN_X0: f64 = -3.85; // centre of the first window

fn window_center_x(i: usize) -> f64 {
    WIN_X0 + i as f64 * WIN_PITCH
}

/// Author the synthetic model: a 10 m × 0.1 m × 3 m wall and one opening whose
/// body is `N_WINDOWS` separate 0.5 m boxes (z ∈ [1, 2]) punched through it.
fn build_ifc() -> String {
    let mut s = String::new();
    s.push_str(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION(('issue-1367 multibody opening'),'2;1');\n\
         FILE_NAME('mb.ifc','2026-06-26T00:00:00',(''),(''),'ifc-lite','ifc-lite','');\n\
         FILE_SCHEMA(('IFC2X3'));\n\
         ENDSEC;\n\
         DATA;\n\
         #2=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);\n\
         #5=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #6=IFCDIRECTION((0.,0.,1.));\n\
         #7=IFCDIRECTION((1.,0.,0.));\n\
         #8=IFCAXIS2PLACEMENT3D(#5,#6,#7);\n\
         #10=IFCUNITASSIGNMENT((#11));\n\
         #11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
         #20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#8,$);\n\
         #1=IFCPROJECT('0proj0000000000000001',#2,'P',$,$,$,$,(#20),#10);\n\
         #30=IFCLOCALPLACEMENT($,#8);\n\
         #40=IFCCARTESIANPOINT((0.,0.));\n\
         #41=IFCDIRECTION((1.,0.));\n\
         #42=IFCAXIS2PLACEMENT2D(#40,#41);\n\
         #43=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,10.,0.1);\n\
         #44=IFCEXTRUDEDAREASOLID(#43,#8,#6,3.);\n\
         #45=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#44));\n\
         #46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));\n\
         #50=IFCWALLSTANDARDCASE('wall00000000000001',#2,'wall',$,$,#30,#46,'t1');\n",
    );

    // The opening's body: N separate boxes, each its own extrusion.
    let mut next = 200u32;
    let mut item_refs = Vec::with_capacity(N_WINDOWS);
    for i in 0..N_WINDOWS {
        let x = window_center_x(i);
        let (pt, ax, prof, solid) = (next, next + 1, next + 2, next + 3);
        next += 4;
        s.push_str(&format!("#{pt}=IFCCARTESIANPOINT(({x:.4},0.,1.));\n"));
        s.push_str(&format!("#{ax}=IFCAXIS2PLACEMENT3D(#{pt},#6,#7);\n"));
        // 0.5 m (X) × 0.3 m (Y, > wall thickness) box, extruded 1 m up from z=1.
        s.push_str(&format!("#{prof}=IFCRECTANGLEPROFILEDEF(.AREA.,'',#42,0.5,0.3);\n"));
        s.push_str(&format!("#{solid}=IFCEXTRUDEDAREASOLID(#{prof},#{ax},#6,1.);\n"));
        item_refs.push(format!("#{solid}"));
    }
    let items = item_refs.join(",");
    let (rep, pds, opening, rel) = (next, next + 1, next + 2, next + 3);
    s.push_str(&format!("#{rep}=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',({items}));\n"));
    s.push_str(&format!("#{pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\n"));
    s.push_str(&format!(
        "#{opening}=IFCOPENINGELEMENT('opening00000000001',#2,'op',$,$,#30,#{pds},'t2');\n"
    ));
    s.push_str(&format!(
        "#{rel}=IFCRELVOIDSELEMENT('void000000000000001',#2,$,$,#50,#{opening});\n"
    ));
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(h), Some(o)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(h).or_default().push(o);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

/// Is `(x, z)` covered by any wall triangle lying on the front face (Y≈0.05)?
fn front_face_covers(mesh: &Mesh, x: f64, z: f64) -> bool {
    let p = |i: u32| {
        let b = i as usize * 3;
        [mesh.positions[b] as f64, mesh.positions[b + 1] as f64, mesh.positions[b + 2] as f64]
    };
    for t in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        if (a[1] - WALL_FRONT_Y).abs() > 1e-3
            || (b[1] - WALL_FRONT_Y).abs() > 1e-3
            || (c[1] - WALL_FRONT_Y).abs() > 1e-3
        {
            continue;
        }
        // Point-in-triangle in the (X, Z) plane.
        let s = |u: [f64; 3], v: [f64; 3]| (u[0] - x) * (v[2] - z) - (v[0] - x) * (u[2] - z);
        let (d1, d2, d3) = (s(a, b), s(b, c), s(c, a));
        let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
        let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
        if !(neg && pos) {
            return true;
        }
    }
    false
}

#[test]
fn multibody_separated_opening_cuts_every_hole() {
    let ifc = build_ifc();
    let entity_index = build_entity_index(&ifc);
    let mut decoder = EntityDecoder::with_index(&ifc, entity_index);
    let router = GeometryRouter::with_units(&ifc, &mut decoder);
    let void_index = build_void_index(&ifc);
    assert_eq!(void_index.get(&WALL_ID).map(Vec::len), Some(1), "wall must have one opening");

    let wall = decoder.decode_by_id(WALL_ID).expect("decode wall");
    let mesh = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("cut wall");
    assert!(!mesh.indices.is_empty(), "cut wall must not be empty");

    // Every window centre (z = 1.5) must be a HOLE on the front face — no
    // triangle may bridge it. A merge-and-subtract regression refills some.
    let filled: Vec<usize> = (0..N_WINDOWS)
        .filter(|&i| front_face_covers(&mesh, window_center_x(i), 1.5))
        .collect();
    assert!(
        filled.is_empty(),
        "windows still bridged on the front face (indices {filled:?}) — the \
         multi-body opening was merged into one cutter instead of split per body"
    );
}
