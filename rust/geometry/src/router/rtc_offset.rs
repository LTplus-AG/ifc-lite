// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! RTC (Relative-to-Center) offset detection: sampling element translations
//! and first geometry vertices to decide whether a model needs re-basing.

use super::GeometryRouter;
use ifc_lite_core::{has_geometry_by_name, DecodedEntity, EntityDecoder, IfcType};

impl GeometryRouter {
    /// Compute median-based RTC offset from sampled translations.
    /// Returns `(0,0,0)` if empty or coordinates are within 10km of origin.
    fn rtc_offset_from_translations(translations: &[(f64, f64, f64)]) -> (f64, f64, f64) {
        if translations.is_empty() {
            return (0.0, 0.0, 0.0);
        }

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

        const THRESHOLD: f64 = 10000.0;
        if centroid.0.abs() > THRESHOLD
            || centroid.1.abs() > THRESHOLD
            || centroid.2.abs() > THRESHOLD
        {
            return centroid;
        }

        (0.0, 0.0, 0.0)
    }

    /// Sample a building element's world-space position for RTC offset detection.
    ///
    /// First checks the placement transform translation. If placement is near
    /// the origin (< 100 m), also probes the first geometry vertex — infrastructure
    /// models (12d Model, Civil 3D) embed large world coordinates directly in
    /// Brep/tessellated geometry with an identity placement.
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

        // If placement is near origin, also check actual geometry vertex coordinates.
        // Infrastructure models embed world coords (e.g. 280 000, 6 214 000) directly
        // in geometry vertices with identity placement — placement-only sampling
        // would miss the large coordinates and fail to detect the need for RTC.
        const NEAR_ORIGIN: f64 = 1000.0;
        if tx.abs() < NEAR_ORIGIN && ty.abs() < NEAR_ORIGIN && tz.abs() < NEAR_ORIGIN {
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

    /// True when the element carries at least one meshable body/surface shape
    /// representation (as opposed to only curve/axis/footprint representations,
    /// e.g. an IfcAlignmentSegment). Used to decide whether an origin-placed
    /// element with no cheaply-samplable vertex may still cast a "no shift"
    /// (0,0,0) vote during RTC detection.
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
            sr.ifc_type == IfcType::IfcShapeRepresentation
                && sr
                    .get(2)
                    .and_then(|a| a.as_string())
                    .map(super::is_body_representation)
                    .unwrap_or(false)
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

        for shape_rep in &reps {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }
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
                    IfcType::IfcFacetedBrep | IfcType::IfcFacetedBrepWithVoids => {
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

    fn raw_coordinate_is_large(&self, point: (f64, f64, f64)) -> bool {
        const LARGE_COORD_THRESHOLD_METERS: f64 = 10000.0;
        let max_abs = point.0.abs().max(point.1.abs()).max(point.2.abs());
        max_abs * self.unit_scale > LARGE_COORD_THRESHOLD_METERS
    }

    pub(super) fn representation_item_uses_raw_large_coordinates(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> bool {
        let first_vertex = match item.ifc_type {
            IfcType::IfcFacetedBrep | IfcType::IfcFacetedBrepWithVoids => {
                self.brep_first_vertex(item, decoder)
            }
            IfcType::IfcTriangulatedFaceSet
            | IfcType::IfcTriangulatedIrregularNetwork
            | IfcType::IfcPolygonalFaceSet => self.tessellated_first_vertex(item, decoder),
            IfcType::IfcFaceBasedSurfaceModel | IfcType::IfcShellBasedSurfaceModel => {
                let Some(shells_attr) = item.get(0) else {
                    return false;
                };
                let Some(shells) = shells_attr.as_list() else {
                    return false;
                };
                let Some(shell_ref) = shells.first() else {
                    return false;
                };
                let Some(shell_id) = shell_ref.as_entity_ref() else {
                    return false;
                };
                match decoder.decode_by_id(shell_id) {
                    Ok(shell) => self.shell_first_vertex(&shell, decoder),
                    Err(_) => None,
                }
            }
            _ => None,
        };

        first_vertex
            .map(|point| self.raw_coordinate_is_large(point))
            .unwrap_or(false)
    }

    /// Detect RTC offset by scanning the file for building elements.
    /// Used by synchronous parse paths.
    pub fn detect_rtc_offset_from_first_element<T>(
        &self,
        content: &T,
        decoder: &mut EntityDecoder,
    ) -> (f64, f64, f64)
    where
        T: AsRef<[u8]> + ?Sized,
    {
        let content = content.as_ref();
        use ifc_lite_core::EntityScanner;

        let mut scanner = EntityScanner::new(content);
        let mut translations: Vec<(f64, f64, f64)> = Vec::new();
        const MAX_SAMPLES: usize = 50;

        while let Some((_id, type_name, start, end)) = scanner.next_entity() {
            if translations.len() >= MAX_SAMPLES {
                break;
            }
            // Use the canonical has_geometry_by_name check from the schema
            // instead of a hardcoded list — any entity class with geometry
            // is a valid candidate for RTC offset sampling.
            if !has_geometry_by_name(type_name) {
                continue;
            }
            if let Ok(entity) = decoder.decode_at(start, end) {
                if let Some(t) = self.sample_element_translation(&entity, decoder) {
                    translations.push(t);
                }
            }
        }

        Self::rtc_offset_from_translations(&translations)
    }

    /// Detect RTC offset using pre-collected geometry jobs (avoids re-scanning the file).
    /// Returns `None` when no usable translation samples were found, allowing
    /// callers to distinguish "no shift needed" from "detection had no data".
    pub fn detect_rtc_offset_from_jobs(
        &self,
        jobs: &[(u32, usize, usize, IfcType)],
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        const MAX_SAMPLES: usize = 50;
        // Cap on USABLE samples, not raw jobs: `take` follows `filter_map` so
        // elements that abstain (origin-placed curve/axis-only reps such as
        // IfcAlignmentSegment, which return None) do not consume the sample
        // budget. Otherwise a file that emits 50+ alignment segments before its
        // real large-coordinate solids would fill the window with abstentions,
        // sample zero positions, and miss the re-basing the solids need.
        // Matches `detect_rtc_offset_from_first_element`, which likewise counts
        // pushed samples rather than scanned entities.
        let translations: Vec<(f64, f64, f64)> = jobs
            .iter()
            .filter_map(|&(id, start, end, _)| {
                let entity = decoder.decode_at_with_id(id, start, end).ok()?;
                self.sample_element_translation(&entity, decoder)
            })
            .take(MAX_SAMPLES)
            .collect();

        if translations.is_empty() {
            return None;
        }
        Some(Self::rtc_offset_from_translations(&translations))
    }

    /// Detect the RTC offset from sampled jobs, falling back to a full-file
    /// placement-bounds scan when no usable translation samples were found.
    ///
    /// Single shared entry point for the server processing path and the wasm
    /// prepasses so both sides make the identical needs-shift decision: a
    /// model whose sampled placements fail to decode while raw geometry
    /// carries >10 km coordinates must be re-based identically everywhere
    /// (previously the wasm prepasses silently fell back to (0,0,0) and the
    /// browser rendered f32 vertex jitter that the server never saw).
    pub fn detect_rtc_offset_with_fallback(
        &self,
        jobs: &[(u32, usize, usize, IfcType)],
        decoder: &mut EntityDecoder,
        content: &[u8],
    ) -> (f64, f64, f64) {
        match self.detect_rtc_offset_from_jobs(jobs, decoder) {
            Some(offset) => offset,
            None => ifc_lite_core::scan_placement_bounds(content).rtc_offset(),
        }
    }
}
