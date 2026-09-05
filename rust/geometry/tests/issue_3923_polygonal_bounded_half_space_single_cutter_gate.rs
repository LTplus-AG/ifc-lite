// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3923 — `apply_boolean_step`'s single-cutter
//! `IfcPolygonalBoundedHalfSpace` branch (the sibling of #3919/#3922's
//! `try_union_polygonal_chain` chain path) must not accept an accept-gate
//! rejected subtract as a real clip.
//!
//! Self-contained (no external fixture): the host is a hand-authored
//! `IfcFacetedBrep` box missing its top face — the same "open box" shape
//! `open_box_mesh` in `rust/geometry/src/csg/csg_tests.rs` uses to trip
//! `csg_topology_gate` / `csg_manifold_gate` — cut by a single
//! `IfcPolygonalBoundedHalfSpace` whose bounded prism spans from the box's
//! mid-height straight through the missing top face. `try_union_polygonal_chain`
//! only batches chains of 2+ PBHS cutters (see its doc comment: "Returns
//! `Ok(None)` ... when the chain has fewer than two PBHS cutters"), so this
//! single cutter reaches `apply_boolean_step`'s own branch, not the path
//! #3922 already hardened.
//!
//! Under a gate, the kernel's subtract of the closed prism from the open host
//! is rejected (open/non-manifold input), and `subtract_mesh` hands back the
//! host UN-CUT — the identical shape it returns for "nothing to cut here" —
//! which `difference_result_looks_degenerate` cannot tell apart (an unchanged
//! mesh is trivially a subset of itself). Pre-fix, that un-cut host was
//! accepted as the final clip result; post-fix it must fall through to the
//! branch's own `clip_mesh_with_half_space` fallback, which DOES remove the
//! upper half (a strict superset of the intended bounded cut, but a real cut,
//! not a silent no-op).

use ifc_lite_core::{EntityDecoder, IfcSchema};
use ifc_lite_geometry::{BooleanClippingProcessor, GeometryProcessor, TessellationQuality};

/// Build the STEP content for an open-top box (host, `#1000`) DIFFERENCE'd by
/// a single `IfcPolygonalBoundedHalfSpace` (`#1300`) whose plane sits at the
/// box's mid-height (z = 500 of a 0..1000 box) with material on the +Z side,
/// extruded via a polygon far larger than the box's footprint so the prism
/// fully covers the open top.
fn single_cutter_step() -> String {
    // Host: open box, 0..1000 on every axis, top face (z=1000) omitted.
    // Same triangle-pair-per-face shape as `open_box_mesh` in csg_tests.rs.
    let points = "\
#101=IFCCARTESIANPOINT((0.,0.,0.));
#102=IFCCARTESIANPOINT((1000.,0.,0.));
#103=IFCCARTESIANPOINT((1000.,1000.,0.));
#104=IFCCARTESIANPOINT((0.,1000.,0.));
#105=IFCCARTESIANPOINT((0.,0.,1000.));
#106=IFCCARTESIANPOINT((1000.,0.,1000.));
#107=IFCCARTESIANPOINT((1000.,1000.,1000.));
#108=IFCCARTESIANPOINT((0.,1000.,1000.));
";
    // Triangles: bottom(2) + 4 sides(2 each) = 10. Top face deliberately absent.
    let tris: &[(u32, u32, u32)] = &[
        (101, 103, 102), // bottom
        (101, 104, 103), // bottom
        (101, 105, 108), // -X
        (101, 108, 104), // -X
        (102, 103, 107), // +X
        (102, 107, 106), // +X
        (101, 102, 106), // -Y
        (101, 106, 105), // -Y
        (104, 108, 107), // +Y
        (104, 107, 103), // +Y
    ];
    let mut body = String::new();
    let mut face_ids = Vec::new();
    for (i, (a, b, c)) in tris.iter().enumerate() {
        let loop_id = 200 + i as u32;
        let bound_id = 250 + i as u32;
        let face_id = 300 + i as u32;
        body.push_str(&format!(
            "#{loop_id}=IFCPOLYLOOP((#{a},#{b},#{c}));\n\
#{bound_id}=IFCFACEOUTERBOUND(#{loop_id},.T.);\n\
#{face_id}=IFCFACE((#{bound_id}));\n"
        ));
        face_ids.push(face_id);
    }
    let shell_refs = face_ids
        .iter()
        .map(|id| format!("#{id}"))
        .collect::<Vec<_>>()
        .join(",");
    body.push_str(&format!(
        "#900=IFCCLOSEDSHELL(({shell_refs}));\n\
#1000=IFCFACETEDBREP(#900);\n"
    ));

    // Cutter: IfcPolygonalBoundedHalfSpace.
    //   BaseSurface plane: point (500,500,500), normal +Z.
    //   AgreementFlag = .F. -> material on the AGREEING (+normal) side, i.e.
    //   the DIFFERENCE removes z > 500 (see AgreementFlag semantics comment
    //   in `build_polygonal_bounded_half_space_mesh`).
    //   Position: origin (500,500,0), Z-axis +Z, X-axis +X -- polygon plane
    //   coincides with world XY (offset in Z is projected onto the slope
    //   plane by the builder).
    //   PolygonalBoundary: a square from local (-1000,-1000) to (2000,2000)
    //   -- far larger than the host's 0..1000 XY footprint, so the resulting
    //   prism fully covers the open top face rather than skimming an edge.
    let cutter = "\
#1100=IFCCARTESIANPOINT((500.,500.,500.));
#1101=IFCDIRECTION((0.,0.,1.));
#1102=IFCAXIS2PLACEMENT3D(#1100,#1101,$);
#1103=IFCPLANE(#1102);
#1110=IFCCARTESIANPOINT((500.,500.,0.));
#1111=IFCDIRECTION((0.,0.,1.));
#1112=IFCDIRECTION((1.,0.,0.));
#1113=IFCAXIS2PLACEMENT3D(#1110,#1111,#1112);
#1120=IFCCARTESIANPOINT((-1000.,-1000.));
#1121=IFCCARTESIANPOINT((2000.,-1000.));
#1122=IFCCARTESIANPOINT((2000.,2000.));
#1123=IFCCARTESIANPOINT((-1000.,2000.));
#1124=IFCCARTESIANPOINT((-1000.,-1000.));
#1130=IFCPOLYLINE((#1120,#1121,#1122,#1123,#1124));
#1300=IFCPOLYGONALBOUNDEDHALFSPACE(#1103,.F.,#1113,#1130);
#1400=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#1000,#1300);
";

    format!(
        "ISO-10303-21;\n\
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(),(),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;\n\
DATA;\n{points}{body}{cutter}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Process `#1400` (the DIFFERENCE node) exactly as `GeometryRouter` would.
fn process_single_cutter() -> ifc_lite_geometry::Mesh {
    let content = single_cutter_step();
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let schema = IfcSchema::new();
    let boolean = BooleanClippingProcessor::new();
    let item = decoder.decode_by_id(1400).expect("decode boolean clipping result");
    GeometryProcessor::process(&boolean, &item, &mut decoder, &schema, TessellationQuality::Medium)
        .expect("process boolean clipping result")
}

fn max_z(mesh: &ifc_lite_geometry::Mesh) -> f32 {
    mesh.positions
        .chunks_exact(3)
        .map(|p| p[2])
        .fold(f32::NEG_INFINITY, f32::max)
}

#[cfg(feature = "csg_topology_gate")]
fn min_z(mesh: &ifc_lite_geometry::Mesh) -> f32 {
    mesh.positions
        .chunks_exact(3)
        .map(|p| p[2])
        .fold(f32::INFINITY, f32::min)
}

/// Without either accept gate, the bounded-prism subtract should be accepted
/// directly (the kernel produces a valid, non-rejected cut on this simple
/// input) — a control confirming the fixture itself clips correctly and
/// isn't relying on the gate machinery to produce a sensible result.
#[test]
fn ungated_single_cutter_clips_the_open_host() {
    let mesh = process_single_cutter();
    assert!(!mesh.indices.is_empty(), "expected a non-empty clipped mesh");
    let lo = min_z(&mesh);
    let hi = max_z(&mesh);
    assert!(
        lo >= -0.5 && hi <= 501.0,
        "ungated: expected the clip to remove z > 500, got z in [{lo}, {hi}]"
    );
}

/// RED (pre-#3923-fix) / GREEN (post-fix): under `csg_topology_gate`, the
/// bounded-prism subtract of the closed cutter from the open host is
/// rejected by the gate. Pre-fix, `apply_boolean_step`'s single-cutter PBHS
/// branch accepted the resulting un-cut host (max z = 1000, the full open
/// box) as though it were a real clip. Post-fix it must fall through to
/// `clip_mesh_with_half_space`, which DOES remove the material above the
/// plane (max z must land back down near 500, not stay at the full 1000
/// height of the un-cut host).
#[cfg(feature = "csg_topology_gate")]
#[test]
fn topology_gate_rejection_falls_through_to_half_space_fallback() {
    let mesh = process_single_cutter();
    assert!(!mesh.indices.is_empty(), "expected a non-empty fallback-clipped mesh");
    let lo = min_z(&mesh);
    let hi = max_z(&mesh);
    assert!(
        lo >= -0.5 && hi <= 501.0,
        "a gate rejection must fall through to clip_mesh_with_half_space \
         (real cut, z in [0, ~500]), not accept the un-cut host — got z in [{lo}, {hi}] \
         (the un-cut open host's un-clipped extent would read [0, ~1000])"
    );
}

/// Control: a cutter that does NOT overlap the host at all (plane above the
/// host's top, so subtract_mesh legitimately has "nothing to cut here") must
/// still be accepted as a successful no-op, not misclassified as a
/// rejection. This is the exact distinction the #3919/#3923 fix rests on:
/// `subtract_mesh` returns the identical `Ok(host.clone())` shape for BOTH a
/// legitimate no-op and a gate rejection, so the fix must tell them apart via
/// `has_accept_gate_rejection_since`, not by the returned mesh shape alone.
#[cfg(feature = "csg_topology_gate")]
#[test]
fn topology_gate_legitimate_no_op_still_succeeds() {
    // Same host, but the plane sits above the box entirely (z = 5000) so the
    // bounded prism never intersects the host: a legitimate "nothing to cut
    // here", not a gate rejection.
    let content = single_cutter_step().replace(
        "#1100=IFCCARTESIANPOINT((500.,500.,500.));",
        "#1100=IFCCARTESIANPOINT((500.,500.,5000.));",
    );
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let schema = IfcSchema::new();
    let boolean = BooleanClippingProcessor::new();
    let item = decoder.decode_by_id(1400).expect("decode boolean clipping result");
    let mesh = GeometryProcessor::process(&boolean, &item, &mut decoder, &schema, TessellationQuality::Medium)
        .expect("process boolean clipping result");

    assert!(!mesh.indices.is_empty(), "a non-overlapping cutter must not empty the host");
    let lo = min_z(&mesh);
    let hi = max_z(&mesh);
    assert!(
        lo <= 0.5 && hi >= 999.0,
        "a legitimate no-op (cutter doesn't reach the host) must leave the \
         host at its full un-cut extent (z in [0, 1000]) -- got [{lo}, {hi}]"
    );
}
