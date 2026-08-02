// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Opening classification, merge/extend, and cutter-mesh synthesis.

use super::geom::*;
use super::{GeometryRouter, OpeningType, NORMALIZE_EPSILON};
use crate::{Mesh, Point3, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

impl GeometryRouter {

    /// Resolve an AABB + extrusion direction for an opening, used as the
    /// fallback rectangular cut for high-vertex non-rectangular openings
    /// (issue #635). The opening's full mesh AABB is the only safe choice
    /// when we are about to over-approximate with an axis-aligned box —
    /// a per-item bound can miss part of a multi-item opening (e.g. AC20
    /// round windows store two extrusions with offset depths and the
    /// first one alone wouldn't reach all the way through the wall).
    /// The extrusion direction is best-effort from the first item.
    fn fallback_aabb_for_opening(
        &self,
        opening_entity: &DecodedEntity,
        opening_mesh: &Mesh,
        decoder: &mut EntityDecoder,
    ) -> (Point3<f64>, Point3<f64>, Option<Vector3<f64>>) {
        let dir = self
            .get_opening_item_bounds_with_direction(opening_entity, decoder)
            .ok()
            .and_then(|items| items.into_iter().find_map(|(_, _, d)| d));
        // WORLD bounds: `opening_mesh` may be in its own per-element local frame
        // (wasm), so fold its origin back in. `apply_void_context` then relativizes
        // these by the host origin alongside the cutter mesh, keeping both in the
        // shared host frame (#1310 review).
        let o = opening_mesh.origin;
        let (mn, mx) = opening_mesh.bounds();
        (
            Point3::new(mn.x as f64 + o[0], mn.y as f64 + o[1], mn.z as f64 + o[2]),
            Point3::new(mx.x as f64 + o[0], mx.y as f64 + o[1], mx.z as f64 + o[2]),
            dir,
        )
    }

    pub(super) fn classify_openings(
        &self,
        host: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Vec<OpeningType> {
        self.classify_openings_impl(host, opening_ids, decoder, true)
    }

    /// Classify a subset of a host's openings WITHOUT recording the per-host
    /// diagnostic. Used by the 2D fast path to build the residual (exact-kernel)
    /// context for the ineligible openings after the host's full opening set has
    /// already been diagnosed once — `record_host_opening_diagnostic` appends, so
    /// a second recording for the same host would double-count.
    pub(super) fn classify_openings_quiet(
        &self,
        host: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Vec<OpeningType> {
        self.classify_openings_impl(host, opening_ids, decoder, false)
    }

    fn classify_openings_impl(
        &self,
        host: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
        record_diag: bool,
    ) -> Vec<OpeningType> {
        use super::super::{ClassificationKind, OpeningDiagnostic, OpeningKindDiag};

        // Per-opening diagnostic accumulator for this host. Pushed to the
        // router's `host_opening_diagnostics` map before we return.
        let mut host_diag: Vec<OpeningDiagnostic> = Vec::with_capacity(opening_ids.len());

        let mut openings: Vec<OpeningType> = Vec::new();
        for &opening_id in opening_ids.iter() {
            let opening_entity = match decoder.decode_by_id(opening_id) {
                Ok(e) => e,
                Err(_) => continue,
            };

            // The cutter is kept in WHATEVER frame `process_element` produced — world
            // (native / local frame off) or the opening's own per-element local frame
            // (wasm). `apply_void_context` carries `mesh.origin` through and folds it in
            // f64 when it relativizes the cutter into the host frame, so the opening's
            // detail stays precise even far from the global origin and the AABB-overlap
            // guard sees the cutter at the host (#1297, refined per #1310 review). The
            // bounds derived below are folded to WORLD so the same relativization applies.
            let opening_mesh = match self.process_element(&opening_entity, decoder) {
                Ok(m) if !m.is_empty() => m,
                _ => continue,
            };

            let vertex_count = opening_mesh.positions.len() / 3;

            // Local helper: bump the aggregate counter and push a per-host
            // diagnostic line together. QUIET mode (`record_diag == false`) is a
            // full no-op — the host's opening set was already classified once by
            // `classify_openings`, so bumping `ClassificationStats` again (or
            // pushing a second host diagnostic) would double-count each residual.
            let mut bump = |router: &Self, ck: ClassificationKind, kind: OpeningKindDiag| {
                if record_diag {
                    router.bump_classification(ck);
                    host_diag.push(OpeningDiagnostic { opening_id, kind, vertex_count });
                }
            };

            // Probe per-item geometry up front. An opening that holds several
            // SPATIALLY SEPARATE void solids — a whole row of windows authored
            // under one IfcOpeningElement (issue #1367) — must be classified and
            // subtracted PER ITEM even when its bodies SUM past the high-vertex
            // guard below: merging them into one cutter and subtracting in a
            // single arrangement leaves diagonal bridges over some of the holes
            // (3 of 12 box void bodies on a limestone wall's front face),
            // whereas one cutter per body cuts every hole cleanly.
            //
            // Bodies that TOUCH/OVERLAP are one logical void split into parts
            // (e.g. the inner+outer wall-leaf halves of a single FZK-Haus
            // window) and MUST stay merged — splitting them regresses the
            // gable-wall consolidation watertightness guard into hairline
            // cracks. So the trigger is ">=2 disjoint spatial clusters", not
            // merely ">1 body". The merged high-vertex path also stays for a
            // genuine SINGLE complex sweep (circular / arched / faceted) and for
            // the rare opening whose per-item bounds can't be recovered.
            let item_bounds_with_dir = self
                .get_opening_item_bounds_with_direction(&opening_entity, decoder)
                .unwrap_or_default();
            let separable_bodies =
                item_bounds_with_dir.len() > 1 && spatial_cluster_count(&item_bounds_with_dir) > 1;

            if vertex_count > 100 && !separable_bodies {
                // High-vertex-count single-body openings (circular / arched /
                // faceted sweeps) won't fit through the CSG safety thresholds,
                // so always carry the per-item AABB + extrusion direction
                // as a fallback (issue #635).
                let (fallback_min, fallback_max, fallback_dir) =
                    self.fallback_aabb_for_opening(&opening_entity, &opening_mesh, decoder);
                bump(
                    self,
                    ClassificationKind::NonRectangular,
                    OpeningKindDiag::NonRectangular,
                );
                openings.push(OpeningType::NonRectangular(
                    opening_mesh,
                    fallback_min,
                    fallback_max,
                    fallback_dir,
                ));
            } else if !item_bounds_with_dir.is_empty() {
                    // Per-item geometry-driven classification (origin/main).
                    // The earlier "is_floor_opening" host-aware heuristic
                    // routed every Z-extruded opening through full CSG, which
                    // silently failed for roof windows on shallow-slope roofs
                    // and left the host uncut. The frame-based
                    // DiagonalRectangular path handles tilted rectangular
                    // openings — including rotated-footprint floor openings —
                    // so reserve NonRectangular for genuinely curved or arched
                    // voids.
                    let item_meshes = self
                        .get_opening_item_meshes_world(&opening_entity, decoder)
                        .unwrap_or_default();

                    if item_meshes.len() == item_bounds_with_dir.len() {
                        for ((min_pt, max_pt, extrusion_dir), item_mesh) in item_bounds_with_dir
                            .into_iter()
                            .zip(item_meshes.into_iter())
                        {
                            let frame = infer_opening_frame(&item_mesh, extrusion_dir.as_ref());
                            let direction_is_diagonal = extrusion_dir
                                .map(|d| !is_axis_aligned_direction(&d))
                                .unwrap_or(false);
                            let is_clean_box = is_rectangular_box_mesh(&item_mesh);

                            if let Some(frame) = frame {
                                if !is_clean_box {
                                    bump(
                                        self,
                                        ClassificationKind::NonRectangular,
                                        OpeningKindDiag::NonRectangular,
                                    );
                                    openings.push(OpeningType::NonRectangular(
                                        item_mesh,
                                        min_pt,
                                        max_pt,
                                        extrusion_dir,
                                    ));
                                } else if direction_is_diagonal || !frame.is_axis_aligned() {
                                    bump(
                                        self,
                                        ClassificationKind::Diagonal,
                                        OpeningKindDiag::Diagonal,
                                    );
                                    openings.push(OpeningType::DiagonalRectangular(
                                        item_mesh, frame,
                                    ));
                                } else {
                                    bump(
                                        self,
                                        ClassificationKind::Rectangular,
                                        OpeningKindDiag::Rectangular,
                                    );
                                    openings.push(OpeningType::Rectangular(
                                        min_pt,
                                        max_pt,
                                        extrusion_dir,
                                    ));
                                }
                            } else if is_clean_box {
                                bump(
                                    self,
                                    ClassificationKind::Rectangular,
                                    OpeningKindDiag::Rectangular,
                                );
                                openings.push(OpeningType::Rectangular(
                                    min_pt,
                                    max_pt,
                                    extrusion_dir,
                                ));
                            } else {
                                bump(
                                    self,
                                    ClassificationKind::NonRectangular,
                                    OpeningKindDiag::NonRectangular,
                                );
                                openings.push(OpeningType::NonRectangular(
                                    item_mesh,
                                    min_pt,
                                    max_pt,
                                    extrusion_dir,
                                ));
                            }
                        }
                    } else {
                        for (min_pt, max_pt, extrusion_dir) in item_bounds_with_dir {
                            bump(
                                self,
                                ClassificationKind::Rectangular,
                                OpeningKindDiag::Rectangular,
                            );
                            openings.push(OpeningType::Rectangular(
                                min_pt, max_pt, extrusion_dir,
                            ));
                        }
                    }
                } else {
                    // WORLD bounds (fold the opening's per-element origin); see
                    // `fallback_aabb_for_opening` (#1310 review).
                    let o = opening_mesh.origin;
                    let (open_min, open_max) = opening_mesh.bounds();
                    let min_f64 = Point3::new(
                        open_min.x as f64 + o[0],
                        open_min.y as f64 + o[1],
                        open_min.z as f64 + o[2],
                    );
                    let max_f64 = Point3::new(
                        open_max.x as f64 + o[0],
                        open_max.y as f64 + o[1],
                        open_max.z as f64 + o[2],
                    );

                    bump(
                        self,
                        ClassificationKind::Rectangular,
                        OpeningKindDiag::Rectangular,
                    );
                    openings.push(OpeningType::Rectangular(min_f64, max_f64, None));
                }
        }

        // Stash the per-host diagnostic before returning. `host.ifc_type`
        // implements `Display` to its STEP name (e.g. "IFCWALLSTANDARDCASE").
        if record_diag && !host_diag.is_empty() {
            self.record_host_opening_diagnostic(
                host.id,
                &format!("{}", host.ifc_type),
                host_diag,
            );
        }

        openings
    }

    /// Merge adjacent/overlapping rectangular openings into larger boxes.
    /// This prevents exponential triangle growth when many small openings
    /// tile a wall surface — each clip creates boundary triangles that get
    /// re-split by the next clip, causing O(2^N) growth.
    pub(super) fn merge_rectangular_openings(openings: &[OpeningType]) -> Vec<OpeningType> {
        const MERGE_TOLERANCE: f64 = 0.01; // 1cm tolerance for adjacency

        // Separate rectangular and non-rectangular openings
        let mut rects: Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)> = Vec::new();
        let mut others: Vec<OpeningType> = Vec::new();

        for opening in openings {
            match opening {
                OpeningType::Rectangular(min, max, dir) => {
                    rects.push((*min, *max, *dir));
                }
                other => others.push(other.clone()),
            }
        }

        // Iteratively merge overlapping/adjacent rectangles
        let mut merged = true;
        while merged {
            merged = false;
            let mut i = 0;
            while i < rects.len() {
                let mut j = i + 1;
                while j < rects.len() {
                    let (a_min, a_max, _) = &rects[i];
                    let (b_min, b_max, _) = &rects[j];

                    // Check if boxes overlap or are adjacent (within tolerance)
                    let overlaps_x = a_min.x <= b_max.x + MERGE_TOLERANCE
                        && a_max.x >= b_min.x - MERGE_TOLERANCE;
                    let overlaps_y = a_min.y <= b_max.y + MERGE_TOLERANCE
                        && a_max.y >= b_min.y - MERGE_TOLERANCE;
                    let overlaps_z = a_min.z <= b_max.z + MERGE_TOLERANCE
                        && a_max.z >= b_min.z - MERGE_TOLERANCE;

                    // PHANTOM-VOLUME GUARD (issue #1337): collapsing two AABBs into
                    // their bounding box is only over-cut-free when the boxes already
                    // coincide on at least two axes — then the merge merely extends the
                    // third (overlapping) axis and `bbox(A,B) == A ∪ B`. Two boxes that
                    // overlap on all three axes but coincide on none (a window on one
                    // wall and a door on the perpendicular wall whose AABBs cross at the
                    // building corner) expand into a bounding box that punches a hole
                    // through BOTH walls. This still collapses the O(2^N) case the merge
                    // exists for — a wall tiled with aligned openings coincides on two
                    // axes per pair and folds row-by-row, then column-by-column.
                    let coincides_x = (a_min.x - b_min.x).abs() <= MERGE_TOLERANCE
                        && (a_max.x - b_max.x).abs() <= MERGE_TOLERANCE;
                    let coincides_y = (a_min.y - b_min.y).abs() <= MERGE_TOLERANCE
                        && (a_max.y - b_max.y).abs() <= MERGE_TOLERANCE;
                    let coincides_z = (a_min.z - b_min.z).abs() <= MERGE_TOLERANCE
                        && (a_max.z - b_max.z).abs() <= MERGE_TOLERANCE;
                    let coincident_axes =
                        coincides_x as u8 + coincides_y as u8 + coincides_z as u8;
                    let phantom_free = coincident_axes >= 2;

                    // Check direction compatibility before merging
                    let dirs_compatible = match (&rects[i].2, &rects[j].2) {
                        (Some(a), Some(b)) => {
                            let dot = a.x * b.x + a.y * b.y + a.z * b.z;
                            dot.abs() > 0.99 // Nearly parallel directions
                        }
                        (None, None) => true,
                        _ => false, // One has direction, other doesn't
                    };

                    if overlaps_x && overlaps_y && overlaps_z && dirs_compatible && phantom_free {
                        // Merge into box i
                        let dir = rects[i].2;
                        rects[i] = (
                            Point3::new(
                                a_min.x.min(b_min.x),
                                a_min.y.min(b_min.y),
                                a_min.z.min(b_min.z),
                            ),
                            Point3::new(
                                a_max.x.max(b_max.x),
                                a_max.y.max(b_max.y),
                                a_max.z.max(b_max.z),
                            ),
                            dir,
                        );
                        rects.remove(j);
                        merged = true;
                    } else {
                        j += 1;
                    }
                }
                i += 1;
            }
        }

        // Reconstruct the opening list
        let mut result: Vec<OpeningType> = rects
            .into_iter()
            .map(|(min, max, dir)| OpeningType::Rectangular(min, max, dir))
            .collect();
        result.extend(others);
        result
    }

    // Cut a rectangular opening from a mesh using optimized plane clipping.
    // This is more efficient than full CSG because it only processes triangles
    // that intersect the opening bounds.
    //
    /// Extend opening bounds along extrusion direction to match wall extent
    ///
    /// Projects wall corners onto the extrusion axis and extends the opening
    /// min/max to cover the wall's full extent along that direction.
    /// This ensures openings penetrate multi-layer walls correctly without
    /// causing artifacts for angled walls.
    pub(super) fn extend_opening_along_direction(
        &self,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
        wall_min: Point3<f64>,
        wall_max: Point3<f64>,
        extrusion_direction: Vector3<f64>, // World-space, normalized
    ) -> (Point3<f64>, Point3<f64>) {
        // Use opening center as reference point for projection
        let open_center = Point3::new(
            (open_min.x + open_max.x) * 0.5,
            (open_min.y + open_max.y) * 0.5,
            (open_min.z + open_max.z) * 0.5,
        );

        // Project all 8 corners of the wall box onto the extrusion axis
        let wall_corners = [
            Point3::new(wall_min.x, wall_min.y, wall_min.z),
            Point3::new(wall_max.x, wall_min.y, wall_min.z),
            Point3::new(wall_min.x, wall_max.y, wall_min.z),
            Point3::new(wall_max.x, wall_max.y, wall_min.z),
            Point3::new(wall_min.x, wall_min.y, wall_max.z),
            Point3::new(wall_max.x, wall_min.y, wall_max.z),
            Point3::new(wall_min.x, wall_max.y, wall_max.z),
            Point3::new(wall_max.x, wall_max.y, wall_max.z),
        ];

        // Find min/max projections of wall corners onto extrusion axis
        let mut wall_min_proj = f64::INFINITY;
        let mut wall_max_proj = f64::NEG_INFINITY;

        for corner in &wall_corners {
            // Project corner onto extrusion axis relative to opening center
            let proj = (corner - open_center).dot(&extrusion_direction);
            wall_min_proj = wall_min_proj.min(proj);
            wall_max_proj = wall_max_proj.max(proj);
        }

        // Project opening corners onto extrusion axis
        let open_corners = [
            Point3::new(open_min.x, open_min.y, open_min.z),
            Point3::new(open_max.x, open_min.y, open_min.z),
            Point3::new(open_min.x, open_max.y, open_min.z),
            Point3::new(open_max.x, open_max.y, open_min.z),
            Point3::new(open_min.x, open_min.y, open_max.z),
            Point3::new(open_max.x, open_min.y, open_max.z),
            Point3::new(open_min.x, open_max.y, open_max.z),
            Point3::new(open_max.x, open_max.y, open_max.z),
        ];

        let mut open_min_proj = f64::INFINITY;
        let mut open_max_proj = f64::NEG_INFINITY;

        for corner in &open_corners {
            let proj = (corner - open_center).dot(&extrusion_direction);
            open_min_proj = open_min_proj.min(proj);
            open_max_proj = open_max_proj.max(proj);
        }

        // Extension is a Revit/ArchiCAD heuristic for openings whose authored
        // extrusion depth doesn't quite reach the wall faces — extending the
        // opening along its own extrusion direction makes the cut land
        // cleanly. The heuristic assumes the extrusion direction IS the
        // wall-thickness axis. That assumption breaks in two distinct ways
        // that this gate has to catch:
        //
        // 1. The opening already spans the wall in the extrusion direction
        //    (advanced_model #553029 — a 300 mm horizontal slab extruded
        //    along +Z, the wall's height axis, that already covers the full
        //    wall cross-section). Extension stretches the opening to span
        //    the entire wall.
        //
        // 2. The opening's extrusion direction maps (after the opening's
        //    own `IfcAxis2Placement3D` rotation) to the wall's LONG axis,
        //    not the wall thickness axis (advanced_model #612334 — a 115 mm
        //    column whose IfcExtrudedAreaSolid extrudes a 3.4 m profile by
        //    115 mm, with a Position transform that rotates local +Z to
        //    world +X = the wall's 11.8 m long axis). Pre-fix, the opening
        //    depth equalled wall thickness so the symmetric form of (1)
        //    didn't catch it; extension along +X stretched the opening to
        //    cover the full 11.8 m wall length and the boolean cut wiped
        //    the host.
        let opening_proj_extent = (open_max_proj - open_min_proj).abs();
        let wall_extent_x = (wall_max.x - wall_min.x).abs();
        let wall_extent_y = (wall_max.y - wall_min.y).abs();
        let wall_extent_z = (wall_max.z - wall_min.z).abs();
        let wall_min_extent = wall_extent_x.min(wall_extent_y).min(wall_extent_z);
        // Case (1): opening already spans the wall in the extrusion
        // direction. 5% slack covers openings modelled at exactly wall
        // thickness, which we still want on the extension path so a tiny
        // coplanarity pad gets applied.
        if opening_proj_extent > wall_min_extent * 1.05 {
            return (open_min, open_max);
        }
        // Case (2): the wall extends much further along the extrusion
        // direction than ANY dimension of the opening itself. A typical
        // window/door extrusion makes the wall thickness comparable to the
        // opening's other dimensions; an off-axis extrusion makes the wall
        // length or height tower over the opening box. The opening's own
        // longest dimension is the right reference here: if the wall along
        // extrusion exceeds it, we'd be stretching the opening across an
        // axis that wasn't authored to penetrate the wall.
        let opening_max_dim = (open_max.x - open_min.x)
            .abs()
            .max((open_max.y - open_min.y).abs())
            .max((open_max.z - open_min.z).abs());
        let wall_proj_extent = (wall_max_proj - wall_min_proj).abs();
        if wall_proj_extent > opening_max_dim {
            return (open_min, open_max);
        }
        // Case (3): the opening was authored to extend past the wall on at
        // least one side in extrusion direction. This is a partial-overlap
        // "bite" — issue #832, a 1 × 1 × 0.2 m opening offset so half the
        // 0.2 m depth pokes out the wall's +X face. The Revit "extend to
        // reach the opposite wall face" heuristic that follows is only
        // sound when the opening sits ENTIRELY INSIDE the wall along the
        // extrusion axis (the "opening too short" pattern); when the
        // opening already pokes out one side, applying it stretches the
        // box across the full wall thickness and the AABB clip removes
        // BOTH faces — the punched-through slot the bug reporter saw.
        // Compare projections rather than raw coords so the sign of the
        // extrusion direction is irrelevant.
        const POKE_TOL: f64 = 1e-6;
        let opening_pokes_past_wall = open_min_proj < wall_min_proj - POKE_TOL
            || open_max_proj > wall_max_proj + POKE_TOL;
        if opening_pokes_past_wall {
            return (open_min, open_max);
        }

        // Case (4): RECESS / POCKET pattern (issue #853). The opening starts
        // exactly at one of the wall's faces and ends in the interior — the
        // authored intent is a partial-depth bite from one side, not a
        // through-hole. Extending to reach the opposite face converts the
        // pocket into a through-hole (the user's screenshot on #853).
        //
        // IFC4+ models can author this with `IfcOpeningElement.PredefinedType
        // = .RECESS.`, but we don't have a clean path to read that here —
        // and geometry alone disambiguates the case: in a true "opening too
        // short" pattern the opening floats inside the wall (neither end on
        // a face); in a recess one end is on a face and the other is inside.
        // Use coplanarity-pad tolerance so a tiny float-error offset doesn't
        // mask the alignment.
        let face_align_tol = (wall_max_proj - wall_min_proj).abs() * 1e-5;
        let near_at_min_face = (open_min_proj - wall_min_proj).abs() < face_align_tol;
        let near_at_max_face = (open_max_proj - wall_max_proj).abs() < face_align_tol;
        let far_inside_min = open_min_proj > wall_min_proj + face_align_tol;
        let far_inside_max = open_max_proj < wall_max_proj - face_align_tol;
        let is_recess = (near_at_min_face && far_inside_max) || (near_at_max_face && far_inside_min);
        if is_recess {
            return (open_min, open_max);
        }

        // Calculate how much to extend in each direction along the extrusion axis
        // If wall extends beyond opening, we need to extend the opening
        let extend_backward = (open_min_proj - wall_min_proj).max(0.0); // How much wall extends before opening
        let extend_forward = (wall_max_proj - open_max_proj).max(0.0); // How much wall extends after opening

        // Add a tiny padding past the wall on both sides so the opening's near/far
        // faces never end up exactly coplanar with the wall's near/far faces.
        // Exact coplanarity leaves 0-thickness sliver artifacts in the rectangular
        // clip path (the "completely inside" check in cut_rectangular_opening_no_faces
        // uses a tolerance of 1e-6 on each axis). Scaled to wall depth so the pad
        // stays imperceptible across mm/m unit systems.
        //
        // NOTE: the floor MUST be strictly greater than the clipper's EPSILON
        // (1e-6, see `cut_rectangular_opening_no_faces`) — otherwise sub-cm walls
        // can still land on the equality boundary and re-introduce slivers
        // (per CodeRabbit review on PR #605). We pick 1e-5 (10x EPSILON) for a
        // safe margin. For typical walls the *scaled* term dominates anyway
        // (200 mm wall → 2 µm pad).
        // See issue #604.
        let wall_extent_along_dir = (wall_max_proj - wall_min_proj).abs();
        let coplanarity_pad = (wall_extent_along_dir * 1e-5).max(1e-5);
        let extend_backward = extend_backward + coplanarity_pad;
        let extend_forward = extend_forward + coplanarity_pad;

        // Extend opening bounds along the extrusion direction
        let extended_min = open_min - extrusion_direction * extend_backward;
        let extended_max = open_max + extrusion_direction * extend_forward;

        // Create new AABB that encompasses both original opening and extended points
        // This ensures we don't shrink the opening in other dimensions
        let all_points = [open_min, open_max, extended_min, extended_max];

        let new_min = Point3::new(
            all_points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min),
            all_points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min),
            all_points.iter().map(|p| p.z).fold(f64::INFINITY, f64::min),
        );
        let new_max = Point3::new(
            all_points
                .iter()
                .map(|p| p.x)
                .fold(f64::NEG_INFINITY, f64::max),
            all_points
                .iter()
                .map(|p| p.y)
                .fold(f64::NEG_INFINITY, f64::max),
            all_points
                .iter()
                .map(|p| p.z)
                .fold(f64::NEG_INFINITY, f64::max),
        );

        (new_min, new_max)
    }

    /// An axis-aligned box `[min,max]` as a closed 12-triangle outward-wound mesh —
    /// the cutter solid for a RECTANGULAR opening routed through the exact subtract
    /// (PART B). 24 verts (4 per face) so each face carries its own outward normal.
    pub(super) fn make_box_mesh(min: Point3<f64>, max: Point3<f64>) -> Mesh {
        let mut m = Mesh::with_capacity(24, 36);
        let corners = [
            Point3::new(min.x, min.y, min.z),
            Point3::new(max.x, min.y, min.z),
            Point3::new(max.x, max.y, min.z),
            Point3::new(min.x, max.y, min.z),
            Point3::new(min.x, min.y, max.z),
            Point3::new(max.x, min.y, max.z),
            Point3::new(max.x, max.y, max.z),
            Point3::new(min.x, max.y, max.z),
        ];
        let faces: [(Vector3<f64>, [usize; 4]); 6] = [
            // Parity-sweep fix: the -Z cap was [0, 2, 1, 3] — a CROSSED
            // (bowtie) quad whose two triangles overlap with opposite
            // orientation, making every synthesized rectangular cutter a
            // self-intersecting solid. The exact kernel then emits
            // orientation-corrupted results (volume > un-cut host) and
            // Manifold silently under-cuts. [0, 3, 2, 1] is the proper
            // outward (-Z) winding, mirroring the +Z face reversed.
            (Vector3::new(0.0, 0.0, -1.0), [0, 3, 2, 1]),
            (Vector3::new(0.0, 0.0, 1.0), [4, 5, 6, 7]),
            (Vector3::new(0.0, -1.0, 0.0), [0, 1, 5, 4]),
            (Vector3::new(0.0, 1.0, 0.0), [2, 3, 7, 6]),
            (Vector3::new(-1.0, 0.0, 0.0), [0, 4, 7, 3]),
            (Vector3::new(1.0, 0.0, 0.0), [1, 2, 6, 5]),
        ];
        for (n, idx) in &faces {
            let b = m.vertex_count() as u32;
            m.add_vertex(corners[idx[0]], *n);
            m.add_vertex(corners[idx[1]], *n);
            m.add_vertex(corners[idx[2]], *n);
            m.add_vertex(corners[idx[3]], *n);
            m.add_triangle(b, b + 1, b + 2);
            m.add_triangle(b, b + 2, b + 3);
        }
        m
    }

    /// Remove the INTERNAL MEMBRANE left when an opening is authored as two (or
    /// more) extrusions glued cap-to-cap — the AC20 round windows store two
    /// `IfcExtrudedAreaSolid` with the SAME circle profile and the SAME start
    /// point extruding in OPPOSITE directions, so the combined cutter mesh
    /// carries a back-to-back pair of cap disks where the two solids meet (e.g. 28
    /// tris on a shared plane mid-wall). The exact CSG subtract treats that double
    /// cap as a real boundary and leaves a solid plug at the seam — the window
    /// never cuts through.
    ///
    /// We delete the WHOLE interior cap plane (every cap-facing triangle in an
    /// interior bucket that carries faces pointing both along and against the
    /// axis), not just vertex-coincident pairs: the two disks are often
    /// triangulated DIFFERENTLY, so pair-matching leaves a central plug (a square
    /// patch inside the round hole). Removing the full membrane welds the two
    /// solids into one continuous tube whose only caps are the true outer ends, so
    /// the subtract carves a clean through-hole. A no-op for ordinary single-solid
    /// openings (no interior back-to-back cap plane exists).
    pub(super) fn remove_internal_membrane(opening_mesh: &Mesh, axis_dir: Vector3<f64>) -> Mesh {
        let tri_count = opening_mesh.indices.len() / 3;
        if tri_count < 4 {
            return opening_mesh.clone();
        }
        let p = |i: usize| -> [f64; 3] {
            [
                opening_mesh.positions[i * 3] as f64,
                opening_mesh.positions[i * 3 + 1] as f64,
                opening_mesh.positions[i * 3 + 2] as f64,
            ]
        };
        // Penetration axis: the cutter's cylinder/extrusion axis, along which the
        // two glued solids stack and their shared seam caps lie. Prefer the
        // supplied depth direction; fall back to the cutter's longest bbox axis.
        let mut d = axis_dir;
        if d.norm() < NORMALIZE_EPSILON {
            let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
            for c in opening_mesh.positions.chunks_exact(3) {
                for a in 0..3 {
                    lo[a] = lo[a].min(c[a] as f64);
                    hi[a] = hi[a].max(c[a] as f64);
                }
            }
            let ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
            // Use a total order: non-finite file coords (e.g. `1.E999` → +inf,
            // whose `inf - inf` extent is NaN) would make `partial_cmp` return
            // `None` and panic the `.unwrap()`. `f64::total_cmp` (the idiom used
            // for the sorts in voids/mod.rs) is NaN-safe and deterministic.
            let la = (0..3).max_by(|&i, &j| ext[i].total_cmp(&ext[j])).unwrap();
            d = Vector3::new(
                if la == 0 { 1.0 } else { 0.0 },
                if la == 1 { 1.0 } else { 0.0 },
                if la == 2 { 1.0 } else { 0.0 },
            );
        }
        d /= d.norm();

        // Cutter span along the axis — its extreme ends are the TRUE outer caps,
        // which must be kept.
        let (mut smin, mut smax) = (f64::INFINITY, f64::NEG_INFINITY);
        for c in opening_mesh.positions.chunks_exact(3) {
            let s = c[0] as f64 * d.x + c[1] as f64 * d.y + c[2] as f64 * d.z;
            smin = smin.min(s);
            smax = smax.max(s);
        }
        let span = (smax - smin).abs();
        if span < NORMALIZE_EPSILON {
            return opening_mesh.clone();
        }
        // Bucket cap triangles by their plane offset along the axis (0.5 mm grid,
        // so a flat cap's triangles cluster into one bucket). A bucket touching
        // either extreme is an outer cap and is never removed.
        let cell = (span * 0.005).max(5.0e-4);
        let bucket = |s: f64| (s / cell).round() as i64;
        let (min_b, max_b) = (bucket(smin), bucket(smax));

        // Lateral basis (u, v) ⊥ axis, for the spatial-overlap test below.
        let helper = if d.x.abs() < 0.9 {
            Vector3::new(1.0, 0.0, 0.0)
        } else {
            Vector3::new(0.0, 1.0, 0.0)
        };
        let u = d.cross(&helper).normalize();
        let v = d.cross(&u);

        // Per interior cap-plane bucket, track the LATERAL (⊥ axis) bounding box of
        // the +axis-facing and −axis-facing cap faces SEPARATELY. Two solids glued
        // cap-to-cap leave an outward cap of one and an inward cap of the other on
        // the same plane — but, crucially, with the SAME lateral footprint (the
        // shared disk). Tracking direction alone is not enough: two laterally
        // SEPARATE caps (e.g. side-by-side cutters abutting at one offset) would
        // also carry both directions in the bucket, and welding them would punch
        // through solid material between the holes. So a bucket is a membrane only
        // where the two footprints actually OVERLAP, and only that overlap region
        // is removed — a lone cap or a disjoint neighbour sharing the offset is
        // kept. A genuine two-hole opening is therefore not merged into one.
        let bbox_union = |bb: &mut Option<[f64; 4]>, lu: f64, lv: f64| match bb {
            None => *bb = Some([lu, lu, lv, lv]),
            Some(b) => {
                b[0] = b[0].min(lu);
                b[1] = b[1].max(lu);
                b[2] = b[2].min(lv);
                b[3] = b[3].max(lv);
            }
        };
        let mut buckets: std::collections::HashMap<i64, [Option<[f64; 4]>; 2]> =
            std::collections::HashMap::new();
        // Per cap triangle: (bucket, lateral_u, lateral_v); non-caps use i64::MIN.
        let mut cap_tris: Vec<(i64, f64, f64)> = Vec::with_capacity(tri_count);
        for t in 0..tri_count {
            let (i0, i1, i2) = (
                opening_mesh.indices[t * 3] as usize,
                opening_mesh.indices[t * 3 + 1] as usize,
                opening_mesh.indices[t * 3 + 2] as usize,
            );
            let (a, b, c) = (p(i0), p(i1), p(i2));
            let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if nl < 1e-12 {
                cap_tris.push((i64::MIN, 0.0, 0.0));
                continue;
            }
            let align = (n[0] * d.x + n[1] * d.y + n[2] * d.z) / nl;
            if align.abs() <= 0.9 {
                cap_tris.push((i64::MIN, 0.0, 0.0)); // not a cap (tube wall)
                continue;
            }
            let cx = (a[0] + b[0] + c[0]) / 3.0;
            let cy = (a[1] + b[1] + c[1]) / 3.0;
            let cz = (a[2] + b[2] + c[2]) / 3.0;
            let cs = cx * d.x + cy * d.y + cz * d.z;
            let lu = cx * u.x + cy * u.y + cz * u.z;
            let lv = cx * v.x + cy * v.y + cz * v.z;
            let bk = bucket(cs);
            cap_tris.push((bk, lu, lv));
            if bk != min_b && bk != max_b {
                let e = buckets.entry(bk).or_insert([None, None]);
                bbox_union(&mut e[(align > 0.0) as usize], lu, lv);
            }
        }
        // A bucket is a glued membrane where its +face and −face footprints overlap
        // laterally; the membrane region is that lateral intersection.
        let mut membrane_region: std::collections::HashMap<i64, [f64; 4]> =
            std::collections::HashMap::new();
        for (&bk, dirs) in &buckets {
            if let (Some(neg), Some(pos)) = (dirs[0], dirs[1]) {
                let iu0 = neg[0].max(pos[0]);
                let iu1 = neg[1].min(pos[1]);
                let iv0 = neg[2].max(pos[2]);
                let iv1 = neg[3].min(pos[3]);
                // Require a non-degenerate overlap so caps merely touching at an
                // edge/corner (a real internal partition, not a coincident disk)
                // are not welded.
                if iu1 - iu0 > 1.0e-3 && iv1 - iv0 > 1.0e-3 {
                    membrane_region.insert(bk, [iu0, iu1, iv0, iv1]);
                }
            }
        }
        if membrane_region.is_empty() {
            return opening_mesh.clone();
        }
        let pad = 1.0e-4;
        let mut out = opening_mesh.clone();
        out.indices.clear();
        for t in 0..tri_count {
            let (bk, lu, lv) = cap_tris[t];
            if let Some(r) = membrane_region.get(&bk) {
                if lu >= r[0] - pad && lu <= r[1] + pad && lv >= r[2] - pad && lv <= r[3] + pad
                {
                    continue; // inside the overlapping membrane footprint
                }
            }
            out.indices.push(opening_mesh.indices[t * 3]);
            out.indices.push(opening_mesh.indices[t * 3 + 1]);
            out.indices.push(opening_mesh.indices[t * 3 + 2]);
        }
        out
    }

    /// Push the opening MESH's caps a hair PAST the host along `dir` so a FLUSH
    /// cap interface becomes a clean TRANSVERSAL crossing before the exact-kernel
    /// subtract. Returns the mesh UNCHANGED unless a real flush-cap condition is
    /// present — the conservative default, so a normal through-opening, an
    /// off-axis `dir`, a recess, or an already-poking-through opening is untouched.
    ///
    /// WHY (the #1007 flush roof-opening sliver, PART A): an opening solid whose
    /// cap is authored EXACTLY flush with a host surface meets that surface as a
    /// near-coplanar interface, not a crossing. On a TILTED, f32-imported, faceted
    /// BREP roof the host facets under the cap each sit a fraction of a degree off
    /// the cap plane (~0.1° measured on #1112), so the exact kernel neither sees a
    /// clean transversal crossing NOR an exactly-coplanar pair — it leaves a sliver
    /// bridging the hole. Pushing the flush cap a hair past the surface makes EVERY
    /// host facet under the footprint a genuine transversal crossing, which the
    /// exact kernel cuts cleanly and deterministically (0% footprint coverage on
    /// both #1112 openings; plain f32 vertex translation ⇒ native==wasm).
    ///
    /// FLUSH DETECTION is against the host SURFACE, not its AABB: a cap is extended
    /// only when a host TRIANGLE parallel to it (`|n·dir| ≈ 1`) lies ON the cap's
    /// plane. That is what separates the #1112 roof cap (flush with a roof facet
    /// INTERIOR to the host's projected extent) from a wall #552611 horizontal slot
    /// whose caps float inside the wall with no host facet there — extending the
    /// latter along its authored +Z extrusion would cut the wall in half. A
    /// non-flush cap (a recess inner cap, a clean transversal cap) is left in place,
    /// so a pocket is never converted to a through-hole.
    pub(super) fn extend_opening_mesh_through_host(
        opening_mesh: &Mesh,
        host_mesh: &Mesh,
        dir: Vector3<f64>,
    ) -> Mesh {
        // Weld out any internal cap membrane FIRST: an opening authored as two (or
        // more) extrusions glued cap-to-cap inside the host (e.g. the AC20 round
        // windows) leaves a back-to-back cap pair mid-cutter that the exact subtract
        // treats as a real boundary, leaving a solid plug at the seam. Deseaming here,
        // inside the one helper every void path funnels through, means no current or
        // future call site can forget it. No-op for ordinary single-solid openings.
        let deseamed = Self::remove_internal_membrane(opening_mesh, dir);
        let opening_mesh = &deseamed;

        let len = dir.norm();
        if len < NORMALIZE_EPSILON {
            return opening_mesh.clone();
        }
        let d = dir / len;

        // Opening span along `d`.
        let (mut omn, mut omx) = (f64::INFINITY, f64::NEG_INFINITY);
        for c in opening_mesh.positions.chunks_exact(3) {
            let s = c[0] as f64 * d.x + c[1] as f64 * d.y + c[2] as f64 * d.z;
            omn = omn.min(s);
            omx = omx.max(s);
        }
        let open_span = (omx - omn).abs();
        if open_span < NORMALIZE_EPSILON {
            return opening_mesh.clone();
        }

        // FLUSH-CAP DETECTION against the host SURFACE (not its AABB): is there a
        // host triangle whose plane is ~parallel to a cap (normal·d ≈ ±1) and whose
        // plane the cap's projection `omn`/`omx` sits ON (within `flush_band`)? Only
        // then is that cap a real flush interface to extend. This is what tells a
        // #1112 roof-opening cap (flush with a roof facet that is INTERIOR to the
        // host's projected extent) apart from a wall #552611 horizontal slot whose
        // caps float inside the wall (no host facet there) — extending the latter
        // along its authored +Z extrusion would cut the wall in half.
        let flush_band = open_span.max(1.0) * 1e-3; // 0.1% of opening depth, scale-rel
        let (mut cap_min_flush, mut cap_max_flush) = (false, false);
        // Farthest host surface coincident with each cap, along `d` (for the push).
        let (mut host_at_min, mut host_at_max) = (omn, omx);
        let vat = |i: u32| {
            let b = i as usize * 3;
            [
                host_mesh.positions[b] as f64,
                host_mesh.positions[b + 1] as f64,
                host_mesh.positions[b + 2] as f64,
            ]
        };
        let vc = host_mesh.positions.len() / 3;
        for t in host_mesh.indices.chunks_exact(3) {
            if (t[0] as usize) >= vc || (t[1] as usize) >= vc || (t[2] as usize) >= vc {
                continue;
            }
            let (a, b, c) = (vat(t[0]), vat(t[1]), vat(t[2]));
            let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if nl < 1e-12 {
                continue;
            }
            // |n·d| ≈ 1 ⇒ host facet parallel to the caps (normal along the
            // penetration axis). 0.985 ≈ 10° — absorbs the ~0.1° facet scatter and
            // a tilted roof's facet wobble without admitting a perpendicular wall.
            let nd = (n[0] * d.x + n[1] * d.y + n[2] * d.z) / nl;
            if nd.abs() < 0.985 {
                continue;
            }
            // the facet's offset along d (any vertex; it's ~constant on the facet)
            let s = a[0] * d.x + a[1] * d.y + a[2] * d.z;
            if (s - omn).abs() <= flush_band {
                cap_min_flush = true;
                host_at_min = host_at_min.min(s);
            }
            if (s - omx).abs() <= flush_band {
                cap_max_flush = true;
                host_at_max = host_at_max.max(s);
            }
        }
        if !cap_min_flush && !cap_max_flush {
            return opening_mesh.clone(); // no flush cap ⇒ a clean transversal cut
        }

        // Push each FLUSH cap a clearance margin PAST its coincident host facet, so
        // the interface becomes a transversal crossing. The margin is NOT a hairline
        // pad: a near-grazing exit (cap a few µm past a TILTED faceted surface)
        // re-creates a coarse T-junction at the facet seam — two rim vertices a few
        // mm apart spanned to a far roof corner, i.e. a high-aspect sliver (the
        // issue #1007 rim-corner CHAMFER on the roof slope, a thin visible flap).
        //
        // The exit must clear the host's FACET VERTICES, not just the surface: on a
        // faceted-BREP roof slope the seam crossing's aspect is set by how close the
        // pushed exit lands to the next facet vertex along the cut. Empirically (host
        // #1112, openings #2150/#2154) the worst rim-incident aspect vs the pad as a
        // fraction of the opening depth is non-monotonic and only settles into the
        // genuine-geometry floor (≈25:1, no >30:1 rim sliver) once the cap clears the
        // surface by ≳ 30 % of the opening's own depth: 5 % → 74:1 (the residual
        // chamfer), 15 % → a near-grazing 1250:1 resonance, 30–40 % → ~25:1 clean.
        // 30 % is the conservative floor of that clean band; it is still small in
        // absolute terms (a few cm on a ~1 m-deep opening, ~9 cm on a 0.3 m window),
        // fires ONLY on a detected flush cap (a floating wall-slot cap is untouched),
        // pushes INTO the host away from neighbouring elements, and stays well short
        // of the engulf guard. Verified: the whole rect-opening + #1007 + #960 suite
        // stays green and `issue_1007_real_opening_no_bridge`'s footprint coverage
        // stays 0 (no bridge).
        let pad = (open_span * 0.30).max(0.01);
        let push_back = if cap_min_flush { (omn - host_at_min).max(0.0) + pad } else { 0.0 };
        let push_fwd = if cap_max_flush { (host_at_max - omx).max(0.0) + pad } else { 0.0 };
        // Only the flush cap ring(s) move; interior loops are untouched (band = a
        // quarter of the opening's own depth).
        let band = (open_span * 0.25).max(1e-6);
        let mut out = opening_mesh.clone();
        for c in out.positions.chunks_exact_mut(3) {
            let p = Point3::new(c[0] as f64, c[1] as f64, c[2] as f64);
            let s = p.x * d.x + p.y * d.y + p.z * d.z;
            let shift = if cap_min_flush && s <= omn + band {
                -push_back
            } else if cap_max_flush && s >= omx - band {
                push_fwd
            } else {
                0.0
            };
            if shift != 0.0 {
                c[0] = (p.x + d.x * shift) as f32;
                c[1] = (p.y + d.y * shift) as f32;
                c[2] = (p.z + d.z * shift) as f32;
            }
        }
        out
    }
}

#[cfg(test)]
#[path = "synthesis_tests.rs"]
mod tests;
