// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Frame-aware item combining for the single-mesh element paths (#6349).
//!
//! `process_element` combines a product's body items into one [`Mesh`].
//! [`Mesh::merge`] rebases an item whose f64 `origin` differs from the
//! accumulator's into the accumulator's f32 positions. Since #5792 an
//! `IfcMappedItem` translated to georeferenced scale keeps that translation in
//! its f64 origin, so a near-origin direct item next to one ~5,000 km away used
//! to put the mapped vertices on a 0.5 m f32 grid. One f64 origin plus one f32
//! position array cannot hold 1e-5 m for both parts, and moving the origin only
//! moves the loss to the other part.
//!
//! So items whose frames are at least [`LARGE_MAPPED_ORIGIN_M`] apart stay in
//! separate meshes ("frame parts"), each with its own origin. Items in frames
//! closer than that merge exactly as before. An ordinary product, whose items
//! all carry a zero origin, therefore yields one part through the unchanged
//! merge sequence. Callers that must keep a single `Mesh` get an explicit error
//! from [`single_frame`] instead of silently rounded geometry.

use super::processing::SourceHygiene;
use super::transforms::LARGE_MAPPED_ORIGIN_M;
use super::GeometryRouter;
use crate::{Error, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Whether `Mesh::merge` may rebase a mesh framed at `b` into one framed at `a`
/// without pushing its f32 positions past the mapped-origin precision limit.
///
/// Written as a negated `>=` so a NaN origin (already-broken input) keeps the
/// historical merge instead of opening a new part.
pub(super) fn frames_mergeable(a: [f64; 3], b: [f64; 3]) -> bool {
    !(0..3).any(|axis| (a[axis] - b[axis]).abs() >= LARGE_MAPPED_ORIGIN_M)
}

/// Collapse frame parts to the single mesh a legacy single-mesh API returns.
///
/// Refuses (rather than rounds) a product whose parts cannot share one frame.
pub(super) fn single_frame(element_id: u32, mut parts: Vec<Mesh>) -> Result<Mesh> {
    if parts.len() <= 1 {
        return Ok(parts.pop().unwrap_or_default());
    }
    Err(Error::geometry(format!(
        "Element #{element_id}: body items lie in {} frames up to {:.3} m apart; one f32 \
         Mesh cannot keep all of them to 1e-5 m (#6349). Use the *_parts router API.",
        parts.len(),
        frame_span(&parts)
    )))
}

/// [`single_frame`] for one mapped source (#6446): `entity` names the
/// `IfcMappedItem` or `IfcRepresentationMap` whose source items would share
/// the single mesh.
pub(super) fn single_frame_source(entity: &str, id: u32, mut parts: Vec<Mesh>) -> Result<Mesh> {
    if parts.len() <= 1 {
        return Ok(parts.pop().unwrap_or_default());
    }
    Err(Error::geometry(format!(
        "{entity} #{id}: mapped source items lie in {} frames up to {:.3} m apart; one f32 \
         Mesh cannot keep all of them to 1e-5 m (#6446). Use the *_parts router API.",
        parts.len(),
        frame_span(&parts)
    )))
}

/// Largest per-axis distance between any two part origins.
fn frame_span(parts: &[Mesh]) -> f64 {
    parts
        .iter()
        .flat_map(|part| parts.iter().map(move |other| (part.origin, other.origin)))
        .map(|(a, b)| (0..3).map(|axis| (a[axis] - b[axis]).abs()).fold(0.0, f64::max))
        .fold(0.0, f64::max)
}

/// Object-frame AABB of a mesh's f32 positions.
pub(super) fn mesh_bounds(mesh: &Mesh) -> [f32; 6] {
    let mut bounds = [
        f32::INFINITY,
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for point in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            bounds[axis] = bounds[axis].min(point[axis]);
            bounds[axis + 3] = bounds[axis + 3].max(point[axis]);
        }
    }
    bounds
}

pub(super) fn union_bounds(accumulator: &mut Option<[f32; 6]>, incoming: [f32; 6]) {
    if let Some(bounds) = accumulator {
        for axis in 0..3 {
            bounds[axis] = bounds[axis].min(incoming[axis]);
            bounds[axis + 3] = bounds[axis + 3].max(incoming[axis + 3]);
        }
    } else {
        *accumulator = Some(incoming);
    }
}

/// Items that could not join the element's primary accumulator, grouped by
/// frame. Each entry keeps the object-frame bounds of the items it holds.
#[derive(Default)]
pub(super) struct FrameParts {
    parts: Vec<(Mesh, Option<[f32; 6]>)>,
}

impl FrameParts {
    /// Merge a non-empty `mesh` into the first part sharing its frame, or
    /// open a new part.
    pub(super) fn merge(&mut self, mesh: &Mesh, bounds: [f32; 6]) {
        match self
            .parts
            .iter_mut()
            .find(|(part, _)| frames_mergeable(part.origin, mesh.origin))
        {
            Some((part, part_bounds)) => {
                part.merge(mesh);
                union_bounds(part_bounds, bounds);
            }
            None => {
                let mut part = Mesh::new();
                part.merge(mesh);
                self.parts.push((part, Some(bounds)));
            }
        }
    }

    pub(super) fn into_parts(self) -> impl Iterator<Item = (Mesh, Option<[f32; 6]>)> {
        self.parts.into_iter()
    }
}

/// The items of one mapped source (`IfcRepresentationMap`), merged the way
/// `mapped_item.rs` and `textured.rs` always merged them, except that an item
/// in a frame at least 1 km from the primary accumulator's opens a frame part
/// (#6446). A single-frame source, which is every source observed in the
/// fixture corpus, runs the exact historical `Mesh::merge` sequence.
#[derive(Default)]
pub(super) struct SourceParts {
    primary: Mesh,
    far: FrameParts,
}

impl SourceParts {
    pub(super) fn merge(&mut self, mesh: &Mesh) {
        if mesh.is_empty() {
            return; // Mesh::merge would ignore it too
        }
        if self.primary.is_empty() || frames_mergeable(self.primary.origin, mesh.origin) {
            self.primary.merge(mesh);
        } else {
            self.far.merge(mesh, mesh_bounds(mesh));
        }
    }

    /// The primary accumulator (possibly empty) followed by any frame parts.
    /// Mapped-source meshes carry no `local_bounds`, as the merged mesh never did.
    pub(super) fn into_parts(self) -> Vec<Mesh> {
        let mut parts = vec![self.primary];
        parts.extend(self.far.into_parts().map(|(part, _bounds)| part));
        parts
    }
}

impl GeometryRouter {
    /// Finish `process_element_parts`: place each far part like the already
    /// placed primary part, then fold the RTC-frame (`rebased`) items into the
    /// first part sharing their placed frame, or keep them as their own part.
    pub(super) fn place_frame_parts(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        hygiene: SourceHygiene,
        primary: Mesh,
        far_parts: FrameParts,
        (mut rebased, rebased_bounds): (Mesh, Option<[f32; 6]>),
    ) -> Result<Vec<Mesh>> {
        let mut parts = vec![primary];
        for (mut part, bounds) in far_parts.into_parts() {
            part.local_bounds = bounds;
            hygiene.for_router(self).apply(&mut part);
            self.apply_placement(element, decoder, &mut part)?;
            parts.push(part);
        }
        if rebased.positions.is_empty() {
            return Ok(parts);
        }
        hygiene.for_router(self).apply(&mut rebased);
        self.apply_placement(element, decoder, &mut rebased)?;
        // Mesh::merge accounts for each mesh's f64 origin. Keep the local
        // bucket's origin so a distant raw item cannot quantize it early;
        // a raw item too far from every part stays its own part (#6349).
        match parts.iter_mut().find(|p| frames_mergeable(p.origin, rebased.origin)) {
            Some(part) => {
                part.merge(&rebased);
                if let Some(bounds) = rebased_bounds {
                    union_bounds(&mut part.local_bounds, bounds);
                }
            }
            None => {
                rebased.local_bounds = rebased_bounds;
                parts.push(rebased);
            }
        }
        Ok(parts)
    }
}

#[cfg(test)]
mod tests {
    //! Parts-API precision for #6349. The single-mesh contract (explicit
    //! error) is witnessed by `tests/issue_6349_single_mesh_span.rs`.
    use super::frames_mergeable;
    use crate::router::GeometryRouter;
    use crate::Mesh;
    use ifc_lite_core::EntityDecoder;
    use rustc_hash::FxHashMap;

    const FAR_X: f64 = 5_000_000.123456;
    const RTC: [f64; 3] = [5_000_000.0, 0.0, 0.0];

    /// Unit box #11 (x/y in [-0.5, 0.5], z in [0, 1]), mapped by #16 to X =
    /// FAR_X; #51 is a raw-world tetrahedron at FAR_X. `body` lists the host's
    /// items, `opening` the items of opening #40 (0.4 m through-hole #33, #38
    /// the same hole mapped to FAR_X).
    fn fixture(body: &str, opening: &str) -> String {
        format!(
            "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCLOCALPLACEMENT($,#2);\
             #4=IFCDIRECTION((0.,0.,1.));#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);\
             #10=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#11=IFCEXTRUDEDAREASOLID(#10,#2,#4,1.);\
             #12=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#11));#13=IFCREPRESENTATIONMAP(#2,#12);\
             #14=IFCCARTESIANPOINT(({FAR_X},0.,0.));#15=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#14,1.,$);\
             #16=IFCMAPPEDITEM(#13,#15);#17=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',({body}));\
             #18=IFCPRODUCTDEFINITIONSHAPE($,$,(#17));\
             #20=IFCBUILDINGELEMENTPROXY('0000000000000000000000',$,'Mixed',$,$,#3,#18,$,$);\
             #30=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.4,0.4);#31=IFCCARTESIANPOINT((0.,0.,-1.));\
             #32=IFCAXIS2PLACEMENT3D(#31,$,$);#33=IFCEXTRUDEDAREASOLID(#30,#32,#4,3.);\
             #36=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#33));#37=IFCREPRESENTATIONMAP(#2,#36);\
             #38=IFCMAPPEDITEM(#37,#15);#34=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',({opening}));\
             #35=IFCPRODUCTDEFINITIONSHAPE($,$,(#34));\
             #40=IFCOPENINGELEMENT('0000000000000000000001',$,'Opening',$,$,#3,#35,$,.OPENING.);\
             #41=IFCRELVOIDSELEMENT('0000000000000000000002',$,$,$,#20,#40);\
             #50=IFCCARTESIANPOINTLIST3D((({FAR_X},-0.5,0.),({x1},-0.5,0.),({FAR_X},0.5,0.),({FAR_X},-0.5,1.)));\
             #51=IFCTRIANGULATEDFACESET(#50,$,.T.,((1,3,2),(1,2,4),(2,3,4),(1,4,3)),$);",
            x1 = FAR_X + 1.0,
        )
    }

    fn volume(mesh: &Mesh) -> f64 {
        let p = |i: u32| [0, 1, 2].map(|k| f64::from(mesh.positions[i as usize * 3 + k]));
        let six: f64 = mesh.indices.chunks_exact(3).map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        }).sum();
        six.abs() / 6.
    }

    /// Assert one near part (the unit box at 0) and one far part whose world
    /// X extent (`origin + position + rtc`) is `far_x` exactly, to 1e-5 m;
    /// y/z match the unit box. Returns (near, far).
    fn near_and_far(parts: &[Mesh], rtc: [f64; 3], far_x: (f64, f64), context: &str) -> (Mesh, Mesh) {
        assert_eq!(parts.len(), 2, "{context}: near and far items stay separate parts");
        let (mut near, mut far) = (None, None);
        for part in parts {
            let extent = |axis: usize| {
                let values = part.positions.chunks_exact(3).map(|p| p[axis] as f64 + part.origin[axis] + rtc[axis]);
                values.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)))
            };
            let is_far = extent(0).0 > 1_000.0;
            let expected = [if is_far { far_x } else { (-0.5, 0.5) }, (-0.5, 0.5), (0.0, 1.0)];
            for (axis, (lo, hi)) in expected.into_iter().enumerate() {
                let (min, max) = extent(axis);
                assert!(
                    (min - lo).abs() < 1e-5 && (max - hi).abs() < 1e-5,
                    "{context}: axis {axis} spans [{min:.9}, {max:.9}], expected [{lo:.9}, {hi:.9}]"
                );
            }
            let slot = if is_far { &mut far } else { &mut near };
            assert!(slot.replace(part.clone()).is_none(), "{context}: one part per frame");
        }
        (near.unwrap(), far.unwrap())
    }

    fn parts(router: &GeometryRouter, body: &str) -> Vec<Mesh> {
        let source = fixture(body, "#33");
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(20).unwrap();
        router.process_element_parts(&element, &mut decoder).unwrap()
    }

    fn rtc_router() -> GeometryRouter {
        let mut router = GeometryRouter::with_scale_and_local_frame(1.0, true);
        router.set_rtc_offset((RTC[0], RTC[1], RTC[2]));
        router
    }

    #[test]
    fn issue_6349_mapped_far_item_and_near_item_keep_1e_5_m() {
        let mapped = (FAR_X - 0.5, FAR_X + 0.5);
        for body in ["#11,#16", "#16,#11"] {
            for (label, router, rtc) in [
                ("absolute", GeometryRouter::with_scale_and_local_frame(1.0, false), [0.0; 3]),
                ("local frame", GeometryRouter::with_scale_and_local_frame(1.0, true), [0.0; 3]),
                ("rtc + local frame", rtc_router(), RTC),
            ] {
                let parts = parts(&router, body);
                let (near, far) = near_and_far(&parts, rtc, mapped, &format!("{label}, items ({body})"));
                assert!((volume(&near) - 1.0).abs() < 1e-5 && (volume(&far) - 1.0).abs() < 1e-5);
            }
        }
    }

    #[test]
    fn issue_6349_raw_world_item_placed_apart_keeps_1e_5_m() {
        // The RTC-frame (raw-world) bucket meets the placed parts only after
        // placement; 5,000 km from the near box it stays its own part.
        let parts = parts(&rtc_router(), "#11,#51");
        assert!(parts.iter().any(|part| part.rtc_applied));
        near_and_far(&parts, RTC, (FAR_X, FAR_X + 1.0), "raw-world tetrahedron");
    }

    #[test]
    fn issue_6349_items_sharing_a_frame_still_merge_into_one_mesh() {
        for body in ["#11,#33", "#16,#38"] {
            let source = fixture(body, "#33");
            let mut decoder = EntityDecoder::new(&source);
            let element = decoder.decode_by_id(20).unwrap();
            let router = GeometryRouter::new();
            let parts = router.process_element_parts(&element, &mut decoder).unwrap();
            assert_eq!(parts.len(), 1, "items ({body}) share a frame");
            let single = router.process_element(&element, &mut decoder).unwrap();
            assert_eq!((&single.positions, &single.indices), (&parts[0].positions, &parts[0].indices));
            assert_eq!((single.origin, single.local_bounds), (parts[0].origin, parts[0].local_bounds));
        }
    }

    #[test]
    fn issue_6349_voids_cut_each_frame_part_and_keep_its_precision() {
        // A near cutter holes only the near box; a mixed near+far cutter both.
        for (opening, far_volume) in [("#33", 1.0), ("#33,#38", 0.84)] {
            let source = fixture("#11,#16", opening);
            let mut decoder = EntityDecoder::new(&source);
            let element = decoder.decode_by_id(20).unwrap();
            let index = FxHashMap::from_iter([(20, vec![40])]);
            let parts = GeometryRouter::new()
                .process_element_with_voids_parts(&element, &mut decoder, &index)
                .unwrap();
            let (near, far) = near_and_far(&parts, [0.0; 3], (FAR_X - 0.5, FAR_X + 0.5), opening);
            assert!((volume(&near) - 0.84).abs() < 1e-4, "near volume {}", volume(&near));
            assert!((volume(&far) - far_volume).abs() < 1e-4, "far volume {}", volume(&far));
        }
    }

    #[test]
    fn issue_6446_mixed_source_parts_are_never_instanced() {
        // #66 / #71 map a near box plus a nested far box; #14 is the far box alone.
        // #14's source (#11) was cached while meshing #66, so its call is a cache
        // hit; the repeated #66 is a second cold walk, since a mixed source is
        // never cached.
        let source = include_str!("../../tests/fixtures/issue_6446_mapped_source_frames.ifc");
        let mut decoder = EntityDecoder::new(source);
        let router = GeometryRouter::new();
        for (id, frames) in [(66, 2), (71, 2), (14, 1), (66, 2)] {
            let item = decoder.decode_by_id(id).unwrap();
            let parts = router.process_mapped_item_parts(&item, &mut decoder).unwrap();
            assert_eq!(parts.len(), frames, "#{id}");
            // One `rep_identity` template cannot carry two frames.
            assert_eq!(parts.iter().filter(|p| p.instance_meta.is_some()).count(), usize::from(frames == 1), "#{id}");
        }
    }

    #[test]
    fn frames_merge_below_the_mapped_origin_limit_only() {
        assert!(frames_mergeable([0.0; 3], [999.9, -999.9, 0.0]));
        assert!(!frames_mergeable([0.0; 3], [0.0, 0.0, 1_000.0]));
        // A NaN origin is already broken input; it keeps the historical merge.
        assert!(frames_mergeable([f64::NAN, 0.0, 0.0], [0.0; 3]));
    }
}
