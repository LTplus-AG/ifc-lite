// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #7685 (Rust sweep B6a): profile holes and profile regions that the
//! swept-solid processors dropped.
//!
//! - PROC-4: `IfcRevolvedAreaSolid` revolved only `Profile2D::outer`, so a
//!   revolved hollow profile rendered filled, and its side walls ignored the
//!   profile winding and the sign of `Angle`.
//! - PROC-AL-5: `IfcSectionedSolidHorizontal` lofted only the outer ring, so
//!   a hollow cross-section (box girder, pipe) rendered as a solid prism.
//! - PROC-15: `IfcCompositeProfileDef` made every sub-profile after the first
//!   a "hole" of the first, although the sub-profiles are disjoint areas.
//!
//! Every test asserts the VOLUME (divergence theorem over the raw processor
//! output, before the pipeline's outward orienter can mask anything), so a
//! filled hole or an inside-out wall cannot pass. Where the solid is a single
//! shell it also asserts the raw mesh is closed and already outward.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{orient_mesh_outward_verdict, GeometryRouter, Mesh};
use nalgebra::Vector3;

#[path = "issue_7685/budget.rs"]
mod budget;
#[path = "issue_7685/composite.rs"]
mod composite;
#[path = "issue_7685/revolved.rs"]
mod revolved;
#[path = "issue_7685/sectioned.rs"]
mod sectioned;

/// Wrap `data` (the DATA section body) into a minimal IFC file. No unit
/// assignment: lengths are metres and plane angles radians.
pub fn ifc(schema: &str, data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('{schema}'));\n\
         ENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// The raw mesh of representation item `#id` (no element placement, no
/// pipeline orientation pass).
pub fn mesh_of(content: &str, id: u32) -> Mesh {
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(id).expect("decode item");
    let mesh = router
        .process_representation_item(&entity, &mut decoder)
        .unwrap_or_else(|e| panic!("#{id} must tessellate: {e}"));
    assert!(!mesh.indices.is_empty(), "#{id} produced an empty mesh");
    mesh
}

/// Signed volume by the divergence theorem, referenced to the mesh's AABB
/// centre so the sign is shape, not position.
pub fn signed_volume(mesh: &Mesh) -> f64 {
    let p = |i: u32| {
        let k = i as usize * 3;
        Vector3::new(
            mesh.positions[k] as f64,
            mesh.positions[k + 1] as f64,
            mesh.positions[k + 2] as f64,
        )
    };
    let mut lo = Vector3::repeat(f64::INFINITY);
    let mut hi = Vector3::repeat(f64::NEG_INFINITY);
    for i in 0..(mesh.positions.len() / 3) as u32 {
        lo = lo.inf(&p(i));
        hi = hi.sup(&p(i));
    }
    let c = (lo + hi) / 2.0;
    mesh.indices
        .chunks_exact(3)
        .map(|t| (p(t[0]) - c).dot(&(p(t[1]) - c).cross(&(p(t[2]) - c))) / 6.0)
        .sum()
}

/// `actual` within `rel` (relative) of `expected`.
pub fn assert_volume(what: &str, actual: f64, expected: f64, rel: f64) {
    assert!(
        (actual - expected).abs() <= rel * expected.abs(),
        "{what}: volume {actual:.4}, expected {expected:.4} (±{:.1}%)",
        rel * 100.0
    );
}

/// The raw mesh is made of `components` closed, orientable shells that are
/// ALREADY wound outward: the orienter has nothing to flip. A wall wound
/// against its caps makes a shell non-orientable; an inside-out shell gets
/// flipped. Both fail here.
pub fn assert_closed_outward(what: &str, mesh: &Mesh, components: u32) {
    let mut probe = mesh.clone();
    let verdict = orient_mesh_outward_verdict(&mut probe);
    assert!(
        verdict.all_closed && verdict.all_orientable,
        "{what}: raw mesh is not a closed orientable solid: {verdict:?}"
    );
    assert_eq!(verdict.components, components, "{what}: shell count: {verdict:?}");
    assert!(!verdict.flipped, "{what}: raw mesh was not wound outward: {verdict:?}");
}
