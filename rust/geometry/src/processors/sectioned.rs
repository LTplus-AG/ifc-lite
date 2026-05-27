// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcSectionedSolidHorizontal` — IFC4x1+ infrastructure entity used
//! for roads, bridges, and alignments. A list of cross-sections at
//! authored stations is swept along an `IfcAlignmentCurve` directrix.
//!
//! ## Pipeline
//!
//! 1. Parse the directrix into an [`AlignmentCurve`]. If the entity is
//!    something other than `IfcAlignmentCurve` we fall back to a
//!    straight-line sweep along the body's local +Y axis.
//! 2. Decode every cross-section via `ProfileProcessor` and every
//!    `IfcDistanceExpression` into a structured position (station +
//!    lateral / vertical / longitudinal offsets + `AlongHorizontal`).
//! 3. **Adaptive subdivision** — between each pair of authored stations
//!    we walk the alignment and add intermediate sample stations
//!    whenever the cumulative heading change exceeds `MAX_ANGLE_STEP`.
//!    This is what lets a sweep authored with only the two endpoints
//!    (e.g. a 134 m guardrail) follow the actual curve instead of being
//!    rendered as a straight chord.
//! 4. For each sample (authored or interpolated) build a placement
//!    frame from the alignment, apply the offsets, then place the
//!    profile vertices in 3D.
//! 5. Stitch the rings into a closed shell: side walls (one quad per
//!    profile edge per consecutive ring pair, with flat-shaded face
//!    normals) plus earcut start- and end-caps.
//!
//! ## `FixedAxisVertical`
//!
//! When the flag is `true` (the common case for roads / bridges) the
//! cross-section is kept upright — local +X = horizontal-right of the
//! horizontal-tangent, local +Y = global +Z. When `false` the
//! cross-section follows the 3D tangent: +X is the horizontal
//! perpendicular to the 3D tangent and +Y is the projection of global
//! +Z onto the cross-section plane.
//!
//! ## Cant
//!
//! Roll about the 3D tangent. Read from any `IfcAlignment2DCant`
//! attached to the alignment (deferred — `AlignmentCurve::cant_angle`
//! is wired through but the parser doesn't traverse the off-axis
//! relationship yet; angle defaults to 0).
//!
//! ## IFC spec references
//!
//! - IfcSectionedSolidHorizontal: IFC4x1 §8.6.2.16
//! - IfcDistanceExpression: IFC4x1 §8.7.3.20 (Offset sign convention:
//!   positive `OffsetLateral` = right of travel)
//! - IfcAlignmentCurve: IFC4x1 §8.7.3.10

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::{Point2, Point3, Vector3};

use crate::{
    alignment::{AlignmentCurve, AlignmentFrame},
    profiles::ProfileProcessor,
    router::GeometryProcessor,
    triangulation::triangulate_polygon,
    Error, Mesh, Profile2D, Result,
};

/// Sweep is subdivided so that no single quad spans more than this much
/// heading change along the directrix. Two degrees keeps the chord-to-
/// arc deviation under ~0.05 % of the local radius, which is invisible
/// at typical viewport scales.
const MAX_ANGLE_STEP_RAD: f64 = 0.0349; // 2°

/// Hard cap on samples added between any two authored stations. Guards
/// against runaway subdivision on pathological alignments.
const MAX_SUBDIVISIONS: usize = 256;

/// Structured IFC4x1 `IfcDistanceExpression`. We carry every attribute
/// because the offsets matter even when they're zero — they're the
/// reason girders / railings authored with only two endpoint stations
/// don't collapse onto the directrix.
#[derive(Debug, Clone, Copy)]
struct PositionAlongDirectrix {
    /// Cumulative distance along the horizontal alignment. The unit is
    /// the file's length unit (the router applies the metre conversion
    /// downstream of the processor).
    distance_along: f64,
    /// Lateral offset perpendicular to the directrix tangent in the
    /// horizontal plane. Positive = right of travel (IFC4x1
    /// convention).
    offset_lateral: f64,
    /// Vertical offset along the world +Z axis.
    offset_vertical: f64,
    /// Offset along the 3D directrix tangent. Always rare but
    /// implemented for completeness.
    offset_longitudinal: f64,
    /// When `true` (default), `distance_along` is measured along the
    /// horizontal projection of the directrix. When `false` it's
    /// measured along the 3D curve including slope.
    along_horizontal: bool,
}

impl PositionAlongDirectrix {
    fn parse(entity: &DecodedEntity) -> Result<Self> {
        let distance_along = entity.get_float(0).ok_or_else(|| {
            Error::geometry("IfcDistanceExpression.DistanceAlong is required".to_string())
        })?;
        let offset_lateral = entity.get_float(1).unwrap_or(0.0);
        let offset_vertical = entity.get_float(2).unwrap_or(0.0);
        let offset_longitudinal = entity.get_float(3).unwrap_or(0.0);
        // AlongHorizontal defaults to TRUE per IFC4x1 if omitted.
        let along_horizontal = entity
            .get(4)
            .and_then(|v| v.as_enum())
            .map(|s| s == "T")
            .unwrap_or(true);
        Ok(Self {
            distance_along,
            offset_lateral,
            offset_vertical,
            offset_longitudinal,
            along_horizontal,
        })
    }

    /// Convert `distance_along` to a horizontal-projection station so
    /// `AlignmentCurve::evaluate` (which is parameterised on horizontal
    /// station) sees a consistent input. When the IFC author specified
    /// the distance as 3D arc length we divide out the average slope —
    /// equivalent to first-order accurate for typical bridge / road
    /// grades (< 5%), which is the regime where `AlongHorizontal=false`
    /// is ever authored.
    fn horizontal_station(&self, alignment: Option<&AlignmentCurve>) -> f64 {
        if self.along_horizontal {
            return self.distance_along;
        }
        let Some(a) = alignment else {
            return self.distance_along;
        };
        // First-order: divide by sqrt(1 + slope²) at the candidate
        // station. One Newton-style refinement gives sub-mm accuracy on
        // realistic grades — see test below.
        let mut station = self.distance_along;
        for _ in 0..4 {
            let frame = a.evaluate(station);
            // tangent.z = sin(atan(slope)); sec(atan(slope)) = 1/cos =
            // 1/√(1−tangent.z²)
            let proj = (1.0 - frame.tangent.z * frame.tangent.z).sqrt().max(1e-9);
            let next = self.distance_along * proj;
            if (next - station).abs() < 1e-6 {
                return next;
            }
            station = next;
        }
        station
    }
}

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
        //   3: FixedAxisVertical         (BOOL — default .T.)
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

        let fixed_axis_vertical = entity
            .get(3)
            .and_then(|v| v.as_enum())
            .map(|s| s == "T")
            .unwrap_or(true);

        let directrix_entity = decoder.decode_by_id(directrix_id)?;
        let alignment = AlignmentCurve::parse(&directrix_entity, decoder)?;

        // Decode authored (profile, position) pairs.
        let mut authored: Vec<(Profile2D, PositionAlongDirectrix)> =
            Vec::with_capacity(sections_list.len());
        for (sec_attr, pos_attr) in sections_list.iter().zip(positions_list.iter()) {
            let sec_id = sec_attr.as_entity_ref().ok_or_else(|| {
                Error::geometry("CrossSection must be an entity reference".to_string())
            })?;
            let sec_entity = decoder.decode_by_id(sec_id)?;
            let profile = self.profile_processor.process(&sec_entity, decoder)?;
            if profile.outer.len() < 3 {
                continue; // Skip degenerate profiles.
            }
            let pos_id = pos_attr.as_entity_ref().ok_or_else(|| {
                Error::geometry("CrossSectionPosition must be an entity reference".to_string())
            })?;
            let pos_entity = decoder.decode_by_id(pos_id)?;
            let position = PositionAlongDirectrix::parse(&pos_entity)?;
            authored.push((profile, position));
        }

        if authored.len() < 2 {
            return Err(Error::geometry(
                "IfcSectionedSolidHorizontal: <2 valid stations after filtering degenerate \
                 cross-sections — nothing to loft"
                    .to_string(),
            ));
        }
        authored.sort_by(|a, b| {
            a.1.distance_along
                .partial_cmp(&b.1.distance_along)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Walk authored pairs, subdividing intermediate stations
        // wherever the alignment curves significantly between them.
        let mut samples: Vec<(Profile2D, PositionAlongDirectrix)> = Vec::new();
        samples.push(authored[0].clone());
        for i in 1..authored.len() {
            let (prev_prof, prev_pos) = (&authored[i - 1].0, authored[i - 1].1);
            let (this_prof, this_pos) = (&authored[i].0, authored[i].1);
            let n = subdivisions(&prev_pos, &this_pos, alignment.as_ref());
            for k in 1..n {
                let t = k as f64 / n as f64;
                let interp_profile = interpolate_profile(prev_prof, this_prof, t);
                let interp_pos = lerp_position(&prev_pos, &this_pos, t);
                samples.push((interp_profile, interp_pos));
            }
            samples.push(authored[i].clone());
        }

        // Place every sample's outer ring in 3D using the alignment
        // frame plus the IfcDistanceExpression offsets.
        let mut rings_3d: Vec<Vec<Point3<f64>>> = Vec::with_capacity(samples.len());
        let mut frames: Vec<AlignmentFrame> = Vec::with_capacity(samples.len());
        for (profile, pos) in &samples {
            let frame = compute_frame(alignment.as_ref(), pos, fixed_axis_vertical);
            rings_3d.push(transform_outer(&profile.outer, &frame));
            frames.push(frame);
        }

        // Build the mesh: start cap, side walls between consecutive
        // rings, end cap. Topology change (varying vertex count between
        // adjacent rings) closes the current sub-sweep and reopens the
        // next one with a backwards-facing cap. The cap's shading
        // normal is the directrix tangent direction at that station so
        // flat-shaded renderers don't sample the side-wall normal.
        let mut mesh = Mesh::new();
        emit_cap(
            &mut mesh,
            &samples[0].0.outer,
            &rings_3d[0],
            -frames[0].tangent,
            false,
        )?;
        for i in 1..samples.len() {
            let (prev_profile, _) = &samples[i - 1];
            let (this_profile, _) = &samples[i];
            let prev_ring = &rings_3d[i - 1];
            let this_ring = &rings_3d[i];

            if prev_profile.outer.len() == this_profile.outer.len()
                && !prev_profile.outer.is_empty()
            {
                emit_side_walls(&mut mesh, prev_ring, this_ring);
            } else {
                // Topology change. Cap off the previous sub-sweep
                // (forward-facing) and reopen with a backwards-facing
                // cap on the new sub-sweep. (Only triggered by
                // authored topology changes — subdivision-introduced
                // sub-samples always match their neighbours.)
                emit_cap(
                    &mut mesh,
                    &prev_profile.outer,
                    prev_ring,
                    frames[i - 1].tangent,
                    true,
                )?;
                emit_cap(
                    &mut mesh,
                    &this_profile.outer,
                    this_ring,
                    -frames[i].tangent,
                    false,
                )?;
            }
        }
        let last = samples.len() - 1;
        emit_cap(
            &mut mesh,
            &samples[last].0.outer,
            &rings_3d[last],
            frames[last].tangent,
            true,
        )?;

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcSectionedSolidHorizontal]
    }
}

// --- Frame placement ---

/// Default placement frame for a straight directrix along world +Y
/// (used when no `IfcAlignmentCurve` is available — keeps legacy
/// fixtures producing reasonable geometry).
fn straight_y_frame(station: f64) -> AlignmentFrame {
    AlignmentFrame {
        origin: Point3::new(0.0, station, 0.0),
        right: Vector3::new(1.0, 0.0, 0.0),
        up: Vector3::new(0.0, 0.0, 1.0),
        tangent: Vector3::new(0.0, 1.0, 0.0),
    }
}

fn evaluate_alignment(alignment: Option<&AlignmentCurve>, station: f64) -> AlignmentFrame {
    match alignment {
        Some(a) => a.evaluate(station),
        None => straight_y_frame(station),
    }
}

/// Build the 3D placement frame at `pos`, honouring offsets,
/// `FixedAxisVertical`, and cant (roll about the tangent).
fn compute_frame(
    alignment: Option<&AlignmentCurve>,
    pos: &PositionAlongDirectrix,
    fixed_axis_vertical: bool,
) -> AlignmentFrame {
    let station = pos.horizontal_station(alignment);
    let base = evaluate_alignment(alignment, station);

    // Pick the axis pair used to embed the cross-section in 3D.
    let (mut right, mut up) = if fixed_axis_vertical {
        // Cross-section stays upright. Right is the horizontal
        // perpendicular to the horizontal tangent (already what
        // `AlignmentCurve::evaluate` returns); up is world +Z.
        (base.right, base.up)
    } else {
        // Cross-section plane is perpendicular to the 3D tangent.
        // right = (tangent × world-Z).normalize() — lies in the
        // horizontal plane, perpendicular to the 3D tangent.
        // up = right × tangent — points "up" inside the cross-section
        // plane (the projection of world-Z onto the perpendicular).
        let world_z = Vector3::new(0.0, 0.0, 1.0);
        let right_candidate = base.tangent.cross(&world_z);
        let right_3d = match right_candidate.try_normalize(1e-9) {
            Some(r) => r,
            // Tangent nearly vertical — fall back to world +X.
            None => Vector3::new(1.0, 0.0, 0.0),
        };
        let up_3d = right_3d.cross(&base.tangent).normalize();
        (right_3d, up_3d)
    };

    // Cant — roll the (right, up) pair about the 3D tangent by the
    // authored cant angle. No-op for fixtures without cant.
    if let Some(a) = alignment {
        let roll = a.cant_angle(station);
        if roll.abs() > 1e-9 {
            let (sin_r, cos_r) = roll.sin_cos();
            let new_right = right * cos_r + up * sin_r;
            let new_up = -right * sin_r + up * cos_r;
            right = new_right;
            up = new_up;
        }
    }

    // Apply the IfcDistanceExpression offsets. Right/up are the
    // unit-length cross-section axes after cant; longitudinal is along
    // the 3D tangent.
    let origin = base.origin
        + base.tangent * pos.offset_longitudinal
        + right * pos.offset_lateral
        + up * pos.offset_vertical;

    AlignmentFrame {
        origin,
        right,
        up,
        tangent: base.tangent,
    }
}

fn transform_outer(outer: &[Point2<f64>], frame: &AlignmentFrame) -> Vec<Point3<f64>> {
    outer
        .iter()
        .map(|p| frame.origin + frame.right * p.x + frame.up * p.y)
        .collect()
}

// --- Subdivision and interpolation ---

/// Number of sub-steps to insert between two authored stations. Walks
/// the alignment in 16 probes and accumulates the angle between
/// successive 3D tangents; `n = max(1, ceil(total_angle /
/// MAX_ANGLE_STEP_RAD))`, capped at `MAX_SUBDIVISIONS`. Straight
/// segments → `n = 1` (no extra samples).
fn subdivisions(
    a: &PositionAlongDirectrix,
    b: &PositionAlongDirectrix,
    alignment: Option<&AlignmentCurve>,
) -> usize {
    let span = (b.distance_along - a.distance_along).abs();
    if span < 1e-9 {
        return 1;
    }
    let Some(curve) = alignment else {
        return 1; // Straight directrix: nothing to subdivide.
    };
    let s_a = a.horizontal_station(Some(curve));
    let s_b = b.horizontal_station(Some(curve));
    const PROBES: usize = 16;
    let mut total_angle = 0.0;
    let mut prev_tan: Option<Vector3<f64>> = None;
    for i in 0..=PROBES {
        let t = i as f64 / PROBES as f64;
        let s = s_a + (s_b - s_a) * t;
        let tan = curve.evaluate(s).tangent;
        if let Some(prev) = prev_tan {
            let cos_a = prev.dot(&tan).clamp(-1.0, 1.0);
            total_angle += cos_a.acos();
        }
        prev_tan = Some(tan);
    }
    let n = (total_angle / MAX_ANGLE_STEP_RAD).ceil() as usize;
    n.max(1).min(MAX_SUBDIVISIONS)
}

/// Linear blend of two `Profile2D`s by parameter `t ∈ [0, 1]`. Requires
/// matching outer-ring vertex count and hole topology; falls back to
/// nearest-endpoint selection otherwise.
fn interpolate_profile(a: &Profile2D, b: &Profile2D, t: f64) -> Profile2D {
    if a.outer.len() != b.outer.len() || a.outer.is_empty() {
        return if t < 0.5 { a.clone() } else { b.clone() };
    }
    let outer: Vec<Point2<f64>> = a
        .outer
        .iter()
        .zip(b.outer.iter())
        .map(|(pa, pb)| {
            Point2::new(
                pa.x * (1.0 - t) + pb.x * t,
                pa.y * (1.0 - t) + pb.y * t,
            )
        })
        .collect();
    let mut result = Profile2D::new(outer);
    if a.holes.len() == b.holes.len() {
        for (ha, hb) in a.holes.iter().zip(b.holes.iter()) {
            if ha.len() == hb.len() {
                let hole: Vec<Point2<f64>> = ha
                    .iter()
                    .zip(hb.iter())
                    .map(|(pa, pb)| {
                        Point2::new(
                            pa.x * (1.0 - t) + pb.x * t,
                            pa.y * (1.0 - t) + pb.y * t,
                        )
                    })
                    .collect();
                result.add_hole(hole);
            }
        }
    }
    result
}

fn lerp_position(
    a: &PositionAlongDirectrix,
    b: &PositionAlongDirectrix,
    t: f64,
) -> PositionAlongDirectrix {
    PositionAlongDirectrix {
        distance_along: a.distance_along * (1.0 - t) + b.distance_along * t,
        offset_lateral: a.offset_lateral * (1.0 - t) + b.offset_lateral * t,
        offset_vertical: a.offset_vertical * (1.0 - t) + b.offset_vertical * t,
        offset_longitudinal: a.offset_longitudinal * (1.0 - t)
            + b.offset_longitudinal * t,
        // AlongHorizontal must agree on both endpoints; if they differ
        // we keep `a`'s convention. The IFC schema doesn't permit
        // mixing the two conventions within a single sweep.
        along_horizontal: a.along_horizontal,
    }
}

// --- Mesh emission ---

/// Triangulate `outer_2d` once and emit triangles using the matching
/// 3D ring. `forward = true` keeps the triangulation winding (front
/// face along `+normal`); `false` flips it.
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
/// Winding assumes both rings are CCW when viewed from −tangent.
fn emit_side_walls(mesh: &mut Mesh, prev_ring: &[Point3<f64>], this_ring: &[Point3<f64>]) {
    let n = prev_ring.len();
    if n < 2 || this_ring.len() != n {
        return;
    }
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
