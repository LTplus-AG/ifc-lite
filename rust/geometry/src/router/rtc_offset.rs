// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! RTC (Relative-to-Center) offset detection: sampling element translations
//! and first geometry vertices to decide whether a model needs re-basing.

use super::GeometryRouter;
use crate::coord_is_large;
use ifc_lite_core::{geometry_flags_by_name, DecodedEntity, EntityDecoder, IfcType, RtcVerdict};

mod raw_coordinate;

/// Whether a near-origin element with this `RepresentationType` may cast a
/// "no-shift" `(0,0,0)` RTC vote when the vertex probe can't cheaply read a
/// coordinate. This is [`is_body_representation`](super::is_body_representation)
/// MINUS `"Surface3D"` — meshable does NOT imply RTC-votable.
///
/// A `Surface3D` rep (`IfcBSplineSurfaceWithKnots`, `IfcSectionedSurface`,
/// trimmed/curve-bounded surfaces) keeps its geometry in absolute model-space
/// control points that `sample_first_geometry_vertex` cannot navigate, so a
/// near-origin identity-placed Surface3D element would fall through to voting
/// its placement `(0,0,0)` even though its real geometry can sit on a national
/// grid hundreds of km away. On IFC4X3 corridor models with many such surfaces
/// ahead of a few large-coordinate solids, those origin votes drag the median
/// to zero and/or exhaust the 50-sample budget, suppressing a legitimate
/// rebase — the #1526 curve-only pollution rebuilt via Surface3D. So Surface3D
/// must ABSTAIN here, like a curve/axis rep. Scoped to RTC voting only: the
/// meshing / void / layer paths still treat Surface3D as body geometry.
fn is_rtc_votable_representation(rep_type: &str) -> bool {
    rep_type != "Surface3D" && super::is_body_representation(rep_type)
}

impl GeometryRouter {
    /// Compute median-based RTC offset from sampled translations.
    /// Returns `(0,0,0)` if the median is within
    /// [`LARGE_COORD_THRESHOLD_METERS`](crate::LARGE_COORD_THRESHOLD_METERS) of the origin.
    fn rtc_offset_from_translations(translations: &[(f64, f64, f64)]) -> (f64, f64, f64) {
        let mut x: Vec<f64> = translations.iter().map(|(x, _, _)| *x).collect();
        let mut y: Vec<f64> = translations.iter().map(|(_, y, _)| *y).collect();
        let mut z: Vec<f64> = translations.iter().map(|(_, _, z)| *z).collect();

        x.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        y.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        z.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let mid = x.len() / 2;
        let centroid = (
            *x.get(mid).unwrap_or(&0.0),
            *y.get(mid).unwrap_or(&0.0),
            *z.get(mid).unwrap_or(&0.0),
        );

        if coord_is_large(centroid) {
            return centroid;
        }

        (0.0, 0.0, 0.0)
    }

    /// Sample a building element's world-space position for RTC offset detection.
    ///
    /// First checks the placement transform translation. If the placement
    /// alone is not already [`coord_is_large`], also probes the first
    /// geometry vertex — infrastructure models (12d Model, Civil 3D) embed
    /// large world coordinates directly in Brep/tessellated geometry with an
    /// identity placement.
    fn sample_element_translation(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let has_rep = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
        if !has_rep {
            return None;
        }
        let mut transform = self
            .get_placement_transform_from_element(entity, decoder)
            .ok()?;
        self.scale_transform(&mut transform);
        let tx = transform[(0, 3)];
        let ty = transform[(1, 3)];
        let tz = transform[(2, 3)];
        if !tx.is_finite() || !ty.is_finite() || !tz.is_finite() {
            return None;
        }

        // If the placement alone would not already answer "large", also check
        // actual geometry vertex coordinates. Infrastructure models embed world
        // coords (e.g. 280 000, 6 214 000) directly in geometry vertices with
        // identity placement — placement-only sampling would miss the large
        // coordinates and fail to detect the need for RTC.
        //
        // Gated on `!coord_is_large`, the SAME predicate the median vote below
        // is judged by (not a separate `< NEAR_ORIGIN` cutoff): a placement
        // exactly AT the threshold used to read as "not near origin" (skip the
        // probe) under a strict `<` comparison, fall through unprobed, and
        // then read as "not large" under `coord_is_large`'s strict `>` — one
        // coordinate, one comparison direction wrong, but disagreeing on
        // whether the probe should have run at all (#4934 review).
        if !coord_is_large((tx, ty, tz)) {
            if let Some((vx, vy, vz)) = self.sample_first_geometry_vertex(entity, decoder) {
                // Transform vertex by placement to get world-space position.
                // The vertex is in raw file units but the placement transform is
                // already unit-scaled, so we must scale the vertex first.
                let world = transform.transform_point(&nalgebra::Point3::new(
                    vx * self.unit_scale,
                    vy * self.unit_scale,
                    vz * self.unit_scale,
                ));
                if world.x.is_finite() && world.y.is_finite() && world.z.is_finite() {
                    return Some((world.x, world.y, world.z));
                }
            }
            // Placement sits at the origin and we could not cheaply read a body
            // vertex. If this element has NO meshable body/surface representation
            // at all — only a curve/axis (e.g. an IfcAlignmentSegment carrying just
            // its 'Axis'/'Segment' curve) — it carries no reliable world position
            // and must NOT vote (0,0,0) into the RTC sample set. Infrastructure
            // files pair a handful of large-coordinate solids with many
            // origin-placed alignment segments, and those spurious origin votes
            // would drag the median back to zero and suppress the re-basing the
            // solids actually need. Report "no evidence" instead.
            //
            // A body element we simply could not sample cheaply (e.g. a swept
            // solid near the origin, which the vertex probe does not walk) still
            // votes (0,0,0): its geometry genuinely sits at the origin, and that
            // "no shift" vote is what keeps origin-local building models with a
            // far georef datum from falling through to the placement-bounds
            // fallback (which would re-base them off-screen).
            if !self.element_has_body_representation(entity, decoder) {
                return None;
            }
        }

        Some((tx, ty, tz))
    }

    /// True when the element carries at least one RTC-votable body shape or
    /// structural Face topology representation, as opposed to only
    /// curve/axis/footprint reps (e.g. an IfcAlignmentSegment) OR a `Surface3D`
    /// rep whose coordinates the vertex probe cannot read. Used to decide
    /// whether an origin-placed element with no cheaply-samplable vertex may
    /// still cast a "no shift" (0,0,0) vote during RTC detection.
    ///
    /// NOTE: this uses [`is_rtc_votable_representation`], NOT
    /// [`is_body_representation`](super::is_body_representation) — the two
    /// differ only in `Surface3D`, which is meshable but not RTC-votable (see
    /// the predicate's doc; #1526).
    fn element_has_body_representation(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> bool {
        let Some(rep_attr) = entity.get(6) else {
            return false;
        };
        if rep_attr.is_null() {
            return false;
        }
        let Ok(Some(rep)) = decoder.resolve_ref(rep_attr) else {
            return false;
        };
        if rep.ifc_type != IfcType::IfcProductDefinitionShape {
            return false;
        }
        let Some(reps_attr) = rep.get(2) else {
            return false;
        };
        let Ok(reps) = decoder.resolve_ref_list(reps_attr) else {
            return false;
        };
        reps.iter().any(|sr| {
            super::effective_element_rep_type(entity, sr).is_some_and(|rep_type| {
                (sr.ifc_type == IfcType::IfcShapeRepresentation
                    && is_rtc_votable_representation(rep_type))
                    || (sr.ifc_type == IfcType::IfcTopologyRepresentation
                        && rep_type == "Face"
                        && super::structural::accepts(entity, rep_type))
            })
        })
    }

    /// Read the first geometry vertex (f64) from an element's representation.
    ///
    /// Navigates the IFC representation hierarchy to extract a single vertex
    /// coordinate without processing the full geometry. Handles the two most
    /// common representation types:
    /// - **Brep**: element → IfcProductDefinitionShape → IfcShapeRepresentation
    ///   → IfcFacetedBrep → IfcClosedShell → IfcFace → IfcFaceBound → IfcPolyLoop
    ///   → first IfcCartesianPoint
    /// - **Tessellated**: element → IfcProductDefinitionShape → IfcShapeRepresentation
    ///   → IfcTriangulatedFaceSet/IfcPolygonalFaceSet → IfcCartesianPointList3D
    ///   → first coordinate triple
    fn sample_first_geometry_vertex(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        // element attr 6 = Representation (IfcProductDefinitionShape)
        let rep_attr = entity.get(6)?;
        if rep_attr.is_null() {
            return None;
        }
        let rep = decoder.resolve_ref(rep_attr).ok()??;
        if rep.ifc_type != IfcType::IfcProductDefinitionShape {
            return None;
        }

        // attr 2 = Representations (list of IfcShapeRepresentation)
        let reps_attr = rep.get(2)?;
        let reps = decoder.resolve_ref_list(reps_attr).ok()?;

        for shape_rep in super::meshed_representations(entity, &reps) {
            // attr 3 = Items (list of geometry items)
            let items = match shape_rep.get(3).and_then(|a| a.as_list()) {
                Some(list) => list,
                None => continue,
            };

            for item_ref in items {
                let item_id = match item_ref.as_entity_ref() {
                    Some(id) => id,
                    None => continue,
                };

                // Try fast CartesianPoint extraction (if item itself is a point)
                if let Some(coords) = decoder.get_cartesian_point_fast(item_id) {
                    return Some(coords);
                }

                let item = match decoder.decode_by_id(item_id) {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                match item.ifc_type {
                    // ── Brep path ──
                    // IfcFacetedBrep attr 0 = Outer (IfcClosedShell)
                    IfcType::IfcFacetedBrep
                    | IfcType::IfcFacetedBrepWithVoids
                    | IfcType::IfcAdvancedBrep
                    | IfcType::IfcAdvancedBrepWithVoids => {
                        if let Some(pt) = self.brep_first_vertex(&item, decoder) {
                            return Some(pt);
                        }
                    }

                    // ── Tessellated path ──
                    // attr 0 = Coordinates (IfcCartesianPointList3D)
                    IfcType::IfcTriangulatedFaceSet
                    | IfcType::IfcTriangulatedIrregularNetwork
                    | IfcType::IfcPolygonalFaceSet => {
                        if let Some(pt) = self.tessellated_first_vertex(&item, decoder) {
                            return Some(pt);
                        }
                    }

                    // ── Surface model path ──
                    IfcType::IfcFaceBasedSurfaceModel | IfcType::IfcShellBasedSurfaceModel => {
                        // attr 0 = FbsmFaces / SbsmBoundary (set of shells)
                        if let Some(shells_attr) = item.get(0) {
                            if let Some(shells) = shells_attr.as_list() {
                                if let Some(shell_ref) = shells.first() {
                                    if let Some(shell_id) = shell_ref.as_entity_ref() {
                                        if let Ok(shell) = decoder.decode_by_id(shell_id) {
                                            // Reuse brep_first_vertex which navigates shell → face → loop → point
                                            if let Some(pt) =
                                                self.shell_first_vertex(&shell, decoder)
                                            {
                                                return Some(pt);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // ── Structural topology path ──
                    IfcType::IfcFaceSurface | IfcType::IfcAdvancedFace => {
                        if let Some(pt) = self.face_first_vertex(&item, decoder) {
                            return Some(pt);
                        }
                    }

                    _ => continue,
                }
            }
        }
        None
    }

    /// Extract first vertex from a Brep entity (IfcFacetedBrep).
    /// Navigates: Brep → ClosedShell → Face → FaceBound → PolyLoop → CartesianPoint
    fn brep_first_vertex(
        &self,
        brep: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let shell_id = brep.get_ref(0)?;
        let shell = decoder.decode_by_id(shell_id).ok()?;
        self.shell_first_vertex(&shell, decoder)
    }

    /// Extract first vertex from a shell entity (IfcClosedShell / IfcOpenShell).
    fn shell_first_vertex(
        &self,
        shell: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let faces = shell.get(0)?.as_list()?;
        let face_id = faces.first()?.as_entity_ref()?;
        let face = decoder.decode_by_id(face_id).ok()?;
        self.face_first_vertex(&face, decoder)
    }

    fn face_first_vertex(
        &self,
        face: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let bounds = face.get(0)?.as_list()?;
        let bound_id = bounds.first()?.as_entity_ref()?;
        let bound = decoder.decode_by_id(bound_id).ok()?;
        let loop_id = bound.get_ref(0)?;
        // Try fast cartesian point extraction from polyloop
        if let Some(coords) = decoder.get_polyloop_coords_cached(loop_id) {
            if let Some(&(x, y, z)) = coords.first() {
                return Some((x, y, z));
            }
        }
        // Fallback: decode the loop and get first point
        let loop_entity = decoder.decode_by_id(loop_id).ok()?;
        if loop_entity.ifc_type == IfcType::IfcPolyLoop {
            let polygon = loop_entity.get(0)?.as_list()?;
            let pt_id = polygon.first()?.as_entity_ref()?;
            return decoder.get_cartesian_point_fast(pt_id);
        }
        if loop_entity.ifc_type == IfcType::IfcEdgeLoop {
            let edge_id = loop_entity.get(0)?.as_list()?.first()?.as_entity_ref()?;
            let oriented = decoder.decode_by_id(edge_id).ok()?;
            let edge = oriented
                .get(2)
                .and_then(|attr| decoder.resolve_ref(attr).ok().flatten())?;
            let vertex = edge
                .get(0)
                .and_then(|attr| decoder.resolve_ref(attr).ok().flatten())?;
            let point_id = vertex.get_ref(0)?;
            return decoder.get_cartesian_point_fast(point_id);
        }
        None
    }

    /// Extract first vertex from a tessellated entity.
    /// Navigates: FaceSet → CartesianPointList3D → first coordinate triple
    fn tessellated_first_vertex(
        &self,
        faceset: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let coord_id = faceset.get_ref(0)?;
        let coord_entity = decoder.decode_by_id(coord_id).ok()?;
        let coord_list = coord_entity.get(0)?.as_list()?;
        let first_triple = coord_list.first()?.as_list()?;
        let x = first_triple.first()?.as_float()?;
        let y = first_triple.get(1)?.as_float()?;
        let z = first_triple.get(2)?.as_float()?;
        Some((x, y, z))
    }

    /// [`Self::detect_rtc_offset_for_file`]'s window with no placement-bounds
    /// fallback. `None` when no usable translation sample was found, so a caller
    /// can tell "no shift needed" from "detection had no data" — the distinction
    /// the streaming ladder in `ifc_lite_processing::stream_meta` climbs.
    pub fn detect_rtc_anchor_for_file(
        &self,
        content: &[u8],
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        self.sample_rtc_offset(content, decoder)
    }

    /// The median sampler behind both detectors here, over the canonical window.
    fn sample_rtc_offset(
        &self,
        content: &[u8],
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        const MAX_SAMPLES: usize = 50;
        // Cap on USABLE samples, not raw jobs: `take` follows `filter_map` so
        // elements that abstain (origin-placed curve/axis-only reps such as
        // IfcAlignmentSegment, which return None) do not consume the sample
        // budget. Otherwise a file that emits 50+ alignment segments before its
        // real large-coordinate solids would fill the window with abstentions,
        // sample zero positions, and miss the re-basing the solids need.
        let translations: Vec<(f64, f64, f64)> = file_geometry_spans(content)
            .filter_map(|(id, start, end)| {
                let entity = decoder.decode_at_with_id(id, start, end).ok()?;
                self.sample_element_translation(&entity, decoder)
            })
            .take(MAX_SAMPLES)
            .collect();
        (!translations.is_empty()).then(|| Self::rtc_offset_from_translations(&translations))
    }

    /// The RTC verdict for `content`: the median over the canonical sample
    /// window, or the full-file placement-bounds scan when that window yielded
    /// no usable translation.
    ///
    /// Single shared entry point for the server processing path, the wasm
    /// prepasses and the overlays, so every one of them makes the identical
    /// needs-shift decision: a model whose sampled placements fail to decode
    /// while raw geometry carries coordinates past
    /// [`crate::LARGE_COORD_THRESHOLD_METERS`] (1 km, was 10 km before
    /// #4934) must be re-based
    /// identically everywhere (previously the wasm prepasses silently fell
    /// back to (0,0,0) and the browser rendered f32 vertex jitter that the
    /// server never saw).
    ///
    /// The spans are [`file_geometry_spans`] — every geometry-bearing entity of
    /// `content`, in file order, sampled lazily to the sampler's usable-sample
    /// cap. They are deliberately NOT a job list the caller passes in: a job
    /// list is a SCHEDULE, and every pipeline schedules differently, so a
    /// caller-supplied window made the median anchor a function of the
    /// scheduler rather than of the model and one file resolved to several
    /// anchors (#4611, pinned by
    /// `wasm-bindings/src/api/gpu_meshes/prepass_tests.rs`).
    ///
    /// `None` means neither ladder found a coordinate to judge; `MeshFrame::select`
    /// in `ifc_lite_processing` decides what that means.
    pub fn detect_rtc_offset_for_file(&self, content: &[u8], decoder: &mut EntityDecoder) -> Option<RtcVerdict> {
        self.detect_rtc_anchor_for_file(content, decoder)
            .map(RtcVerdict::of_anchor)
            .or_else(|| ifc_lite_core::scan_placement_bounds(content).rtc_offset(self.unit_scale))
    }
}

/// The `(id, start, end)` span of every entity the mesh pre-passes schedule,
/// in file order: the canonical `geometry_flags_by_name` check, plus (#1910) a
/// spatial container it blocks by name (`IfcBuilding` et al.) whose instance
/// carries a non-null Representation, mirroring the entity-job scans in
/// `rust/processing/src/processor/mod.rs` and
/// `rust/wasm-bindings/src/api/gpu_meshes/prepass.rs`.
fn file_geometry_spans(content: &[u8]) -> impl Iterator<Item = (u32, usize, usize)> + '_ {
    let mut scanner = ifc_lite_core::EntityScanner::new(content);
    std::iter::from_fn(move || scanner.next_entity()).filter_map(move |(id, type_name, start, end)| {
        let (geometry, spatial) = geometry_flags_by_name(type_name);
        let has_representation = || ifc_lite_core::nth_attribute_is_present(&content[start..end], 6);
        (geometry || (spatial && has_representation())).then_some((id, start, end))
    })
}
