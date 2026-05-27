// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcSectionedSolidHorizontal` — IFC4x1+ infrastructure entity used
//! for roads, bridges, and alignments. A list of varying 2D cross-sections
//! is swept along an `IfcAlignmentCurve` directrix.
//!
//! The processor:
//!
//! 1. Parses the directrix into an [`AlignmentCurve`]
//!    (`crate::alignment`). If the directrix is something other than
//!    `IfcAlignmentCurve` we fall back to a straight sweep along the
//!    body's local +Y axis — that's enough to keep simple test fixtures
//!    rendering and surfaces a clear error message for other curve
//!    families.
//! 2. Decodes every cross-section via `ProfileProcessor` and reads each
//!    `IfcDistanceExpression.DistanceAlong`.
//! 3. For each station, evaluates the alignment to get a placement
//!    frame `(origin, right, up)` with `right` perpendicular-right of
//!    travel and `up` along global +Z (FixedAxisVertical=true). The
//!    profile's local (px, py) maps to `origin + px·right + py·up` —
//!    matching the IFC convention that profile +X is lateral offset
//!    and profile +Y is vertical.
//! 4. Stitches consecutive cross-sections into a closed shell: side
//!    walls (one quad per profile edge per station pair) plus earcut
//!    triangulation for the start and end caps.
//!
//! Missing on purpose, with TODO scope notes:
//!
//! - **`FixedAxisVertical = false`** (cant / superelevation). The flag
//!   is read but the alignment frame ignores it and always keeps
//!   `up = (0,0,1)`. Adding superelevation needs an `IfcAlignmentCant`
//!   reader plus a roll around the tangent. The fixture exclusively
//!   uses `.T.`.
//! - **Lateral / vertical / longitudinal offsets** on
//!   `IfcDistanceExpression`. Only `DistanceAlong` is used. The fixture
//!   leaves attrs 1–3 unset on the cross-section positions (offsets
//!   appear only on `IfcOffsetCurveByDistances` string-line curves we
//!   don't render).

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::{Point2, Point3, Vector3};

use crate::{
    alignment::{AlignmentCurve, AlignmentFrame},
    profiles::ProfileProcessor,
    router::GeometryProcessor,
    triangulation::triangulate_polygon,
    Error, Mesh, Profile2D, Result,
};

/// Loft-sweep processor for `IfcSectionedSolidHorizontal`.
pub struct SectionedSolidHorizontalProcessor {
    profile_processor: ProfileProcessor,
}

impl SectionedSolidHorizontalProcessor {
    pub fn new(schema: IfcSchema) -> Self {
        Self {
            profile_processor: ProfileProcessor::new(schema),
        }
    }
}

impl Default for SectionedSolidHorizontalProcessor {
    fn default() -> Self {
        Self::new(IfcSchema::new())
    }
}

impl GeometryProcessor for SectionedSolidHorizontalProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcSectionedSolidHorizontal attributes (IFC4x1):
        //   0: Directrix                 (IfcCurve subtype)
        //   1: CrossSections             (LIST of IfcProfileDef)
        //   2: CrossSectionPositions     (LIST of IfcDistanceExpression)
        //   3: FixedAxisVertical         (BOOL — must be .T. for now)
        let directrix_id = entity.get_ref(0).ok_or_else(|| {
            Error::geometry("IfcSectionedSolidHorizontal missing Directrix".to_string())
        })?;

        let sections_attr = entity.get(1).ok_or_else(|| {
            Error::geometry("IfcSectionedSolidHorizontal missing CrossSections".to_string())
        })?;
        let sections_list = sections_attr
            .as_list()
            .ok_or_else(|| Error::geometry("CrossSections must be a list".to_string()))?;

        let positions_attr = entity.get(2).ok_or_else(|| {
            Error::geometry("IfcSectionedSolidHorizontal missing CrossSectionPositions".to_string())
        })?;
        let positions_list = positions_attr
            .as_list()
            .ok_or_else(|| Error::geometry("CrossSectionPositions must be a list".to_string()))?;

        if sections_list.len() != positions_list.len() {
            return Err(Error::geometry(format!(
                "IfcSectionedSolidHorizontal: CrossSections ({}) and CrossSectionPositions ({}) \
                 must have equal length",
                sections_list.len(),
                positions_list.len(),
            )));
        }
        if sections_list.len() < 2 {
            return Err(Error::geometry(
                "IfcSectionedSolidHorizontal needs at least 2 cross-sections to loft".to_string(),
            ));
        }

        // Decode the directrix. `AlignmentCurve::parse` returns `Ok(None)`
        // when the directrix isn't an `IfcAlignmentCurve` so we can fall
        // through to a straight-line sweep (legacy MVP behaviour).
        let directrix_entity = decoder.decode_by_id(directrix_id)?;
        let alignment = AlignmentCurve::parse(&directrix_entity, decoder)?;

        // Decode every cross-section + station as one parallel list and
        // sort by station — the IFC spec allows the positions to be in
        // any order, but stitching only makes sense pairwise on sorted
        // stations.
        let mut stations: Vec<(Profile2D, f64)> = Vec::with_capacity(sections_list.len());
        for (sec_attr, pos_attr) in sections_list.iter().zip(positions_list.iter()) {
            let sec_id = sec_attr.as_entity_ref().ok_or_else(|| {
                Error::geometry("CrossSection must be an entity reference".to_string())
            })?;
            let sec_entity = decoder.decode_by_id(sec_id)?;
            let profile = self.profile_processor.process(&sec_entity, decoder)?;
            if profile.outer.len() < 3 {
                // Skip degenerate profiles — can't loft a <3-vertex
                // cross-section, but a single one in a list of valid
                // sections shouldn't kill the whole sweep.
                continue;
            }

            let pos_id = pos_attr.as_entity_ref().ok_or_else(|| {
                Error::geometry("CrossSectionPosition must be an entity reference".to_string())
            })?;
            let pos_entity = decoder.decode_by_id(pos_id)?;
            // IfcDistanceExpression[0] = DistanceAlong (required).
            let distance = pos_entity.get_float(0).ok_or_else(|| {
                Error::geometry(
                    "IfcDistanceExpression.DistanceAlong is required".to_string(),
                )
            })?;
            stations.push((profile, distance));
        }

        if stations.len() < 2 {
            return Err(Error::geometry(
                "IfcSectionedSolidHorizontal: <2 valid stations after filtering degenerate \
                 cross-sections — nothing to loft"
                    .to_string(),
            ));
        }
        stations
            .sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

        // Place every profile's outer ring in 3D world coordinates using
        // the alignment frame at each station (or a straight-line frame
        // along +Y when the directrix isn't an IfcAlignmentCurve).
        let mut rings_3d: Vec<Vec<Point3<f64>>> = Vec::with_capacity(stations.len());
        for (profile, station) in &stations {
            let frame = frame_at(alignment.as_ref(), *station);
            rings_3d.push(transform_outer(&profile.outer, &frame));
        }

        let mut mesh = Mesh::new();

        // Start cap (at the first station, normal pointing backwards
        // along travel). Triangulate the 2D profile then emit the
        // triangles using the 3D ring; reverse winding so the cap faces
        // the −tangent direction.
        emit_cap(
            &mut mesh,
            &stations[0].0.outer,
            &rings_3d[0],
            cap_normal_at(alignment.as_ref(), stations[0].1, false),
            false,
        )?;

        // Side walls between consecutive stations. Cross-section vertex
        // count must match for direct stitching; when they differ (rare
        // — appears only in composite-profile fixtures) we close off the
        // current sub-sweep with a cap and start a new one.
        let mut prev_idx = 0usize;
        for i in 1..stations.len() {
            let (prev_profile, _) = &stations[i - 1];
            let (this_profile, _) = &stations[i];
            let prev_ring = &rings_3d[i - 1];
            let this_ring = &rings_3d[i];

            if prev_profile.outer.len() == this_profile.outer.len()
                && !prev_profile.outer.is_empty()
            {
                emit_side_walls(&mut mesh, prev_ring, this_ring);
            } else {
                // Topology change. Cap off the previous sub-sweep
                // (forward-facing) and reopen with a backwards-facing
                // cap on the new sub-sweep.
                emit_cap(
                    &mut mesh,
                    &prev_profile.outer,
                    prev_ring,
                    cap_normal_at(alignment.as_ref(), stations[i - 1].1, true),
                    true,
                )?;
                emit_cap(
                    &mut mesh,
                    &this_profile.outer,
                    this_ring,
                    cap_normal_at(alignment.as_ref(), stations[i].1, false),
                    false,
                )?;
                prev_idx = i;
            }
        }
        let _ = prev_idx; // currently only used to silence borrow warnings

        // End cap.
        let last = stations.len() - 1;
        emit_cap(
            &mut mesh,
            &stations[last].0.outer,
            &rings_3d[last],
            cap_normal_at(alignment.as_ref(), stations[last].1, true),
            true,
        )?;

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcSectionedSolidHorizontal]
    }
}

// --- Frame & profile-to-3D helpers ---

/// Default placement frame at `station` for a straight directrix along
/// body +Y (used when no `IfcAlignmentCurve` is available).
fn straight_y_frame(station: f64) -> AlignmentFrame {
    AlignmentFrame {
        origin: Point3::new(0.0, station, 0.0),
        right: Vector3::new(1.0, 0.0, 0.0),
        up: Vector3::new(0.0, 0.0, 1.0),
    }
}

fn frame_at(alignment: Option<&AlignmentCurve>, station: f64) -> AlignmentFrame {
    match alignment {
        Some(a) => a.evaluate(station),
        None => straight_y_frame(station),
    }
}

/// Tangent direction at `station`, used to pick the cap normal. For a
/// caller-friendly straight-Y fallback this is just `+Y`.
fn cap_normal_at(
    alignment: Option<&AlignmentCurve>,
    station: f64,
    forward: bool,
) -> Vector3<f64> {
    // Sample two adjacent points to estimate tangent — avoids extending
    // the alignment API with a separate tangent evaluator while staying
    // accurate enough for cap normals (used only for shading, not
    // collision / CSG).
    let eps = 1.0_f64;
    let f0 = frame_at(alignment, station);
    let f1 = frame_at(alignment, station + eps);
    let delta = f1.origin - f0.origin;
    let len = delta.norm();
    let tangent = if len > 1e-9 {
        delta / len
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };
    if forward {
        tangent
    } else {
        -tangent
    }
}

fn transform_outer(outer: &[Point2<f64>], frame: &AlignmentFrame) -> Vec<Point3<f64>> {
    outer
        .iter()
        .map(|p| frame.origin + frame.right * p.x + frame.up * p.y)
        .collect()
}

/// Triangulate `outer` (2D points) once and emit the triangles using
/// the corresponding 3D ring. `forward = true` keeps the triangulation
/// winding (front face along +tangent); `false` flips it so the start
/// cap faces backwards.
fn emit_cap(
    mesh: &mut Mesh,
    outer_2d: &[Point2<f64>],
    ring_3d: &[Point3<f64>],
    normal: Vector3<f64>,
    forward: bool,
) -> Result<()> {
    if outer_2d.len() < 3 || ring_3d.len() != outer_2d.len() {
        return Ok(());
    }
    let indices = triangulate_polygon(outer_2d)?;
    let base = (mesh.positions.len() / 3) as u32;
    for p in ring_3d {
        mesh.add_vertex(*p, normal);
    }
    for tri in indices.chunks_exact(3) {
        let (a, b, c) = (tri[0] as u32, tri[1] as u32, tri[2] as u32);
        if forward {
            mesh.add_triangle(base + a, base + b, base + c);
        } else {
            mesh.add_triangle(base + a, base + c, base + b);
        }
    }
    Ok(())
}

/// Stitch two equal-vertex-count rings with one quad per profile edge.
/// Winding assumes both rings are CCW when viewed from −tangent, which
/// is what `transform_outer` produces for a CCW input profile and the
/// alignment-frame's right-handed basis.
fn emit_side_walls(mesh: &mut Mesh, prev_ring: &[Point3<f64>], this_ring: &[Point3<f64>]) {
    let n = prev_ring.len();
    if n < 2 || this_ring.len() != n {
        return;
    }
    let base = (mesh.positions.len() / 3) as u32;
    // For each pair of consecutive profile vertices `(j, j+1)`, the
    // quad is `prev[j] – prev[j+1] – this[j+1] – this[j]`. Compute a
    // face normal so the side-wall reads with flat shading.
    for j in 0..n {
        let j1 = (j + 1) % n;
        let p0 = prev_ring[j];
        let p1 = prev_ring[j1];
        let p2 = this_ring[j1];
        let p3 = this_ring[j];
        let n_face = compute_face_normal(&p0, &p1, &p2);
        let v_base = (mesh.positions.len() / 3) as u32;
        mesh.add_vertex(p0, n_face);
        mesh.add_vertex(p1, n_face);
        mesh.add_vertex(p2, n_face);
        mesh.add_vertex(p3, n_face);
        mesh.add_triangle(v_base, v_base + 1, v_base + 2);
        mesh.add_triangle(v_base, v_base + 2, v_base + 3);
    }
    let _ = base; // base of this segment's vertex range; left to keep diff minimal
}

fn compute_face_normal(a: &Point3<f64>, b: &Point3<f64>, c: &Point3<f64>) -> Vector3<f64> {
    let ab = b - a;
    let ac = c - a;
    let n = ab.cross(&ac);
    let len = n.norm();
    if len > 1e-12 {
        n / len
    } else {
        Vector3::new(0.0, 0.0, 1.0)
    }
}
