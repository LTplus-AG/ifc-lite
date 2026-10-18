// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcSectionedSolidHorizontal` — IFC4x1+ infrastructure entity used
//! for roads, bridges, and alignments. A list of cross-sections at
//! authored stations is swept along an `IfcAlignmentCurve` directrix.
//!
//! ## Pipeline
//!
//! 1. Parse the directrix into an [`AlignmentCurve`] (`IfcAlignmentCurve`,
//!    `IfcPolyline`, IFC4x3 `IfcGradientCurve`); anything else falls back
//!    to a straight-line sweep along the body's local +Y axis.
//! 2. Decode every cross-section via `ProfileProcessor` and every
//!    position — IFC4x1 `IfcDistanceExpression` or IFC4x3
//!    `IfcAxis2PlacementLinear` → `IfcPointByDistanceExpression` — into a
//!    structured position (station + lateral / vertical / longitudinal
//!    offsets + `AlongHorizontal`).
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
//!    normals) plus earcut start- and end-caps. Every ring of every region
//!    is stitched and capped, holes included (`sectioned_mesh.rs`).
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

use crate::math::tol;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::{Point3, Vector3};

#[path = "sectioned_mesh.rs"]
mod sectioned_mesh;
#[path = "sectioned_positions.rs"]
mod sectioned_positions;
use crate::alignment_arc_length::ArcLengthMap;
use sectioned_positions::PositionAlongDirectrix;

#[path = "sectioned_plan.rs"]
pub(crate) mod plan;

use crate::{
    alignment::{AlignmentCurve, AlignmentFrame},
    profiles::ProfileProcessor,
    router::GeometryProcessor,
    scale_segments, Error, Mesh, Result, TessellationQuality,
};

/// Sweep is subdivided so that no single quad spans more than this much
/// heading change along the directrix. Two degrees keeps the chord-to-
/// arc deviation under ~0.05 % of the local radius, which is invisible
/// at typical viewport scales.
const MAX_ANGLE_STEP_RAD: f64 = 0.0349; // 2°

/// Hard cap on samples added between any two authored stations. Guards
/// against runaway subdivision on pathological alignments.
const MAX_SUBDIVISIONS: usize = 256;

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

    pub(crate) fn lower(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: TessellationQuality) -> Result<plan::SectionedPlan> {
        plan::lower(entity, decoder, quality, &self.profile_processor)
    }
}

impl Default for SectionedSolidHorizontalProcessor {
    fn default() -> Self {
        Self::new(IfcSchema::new())
    }
}

impl GeometryProcessor for SectionedSolidHorizontalProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        if rtc_file_units.is_some() { return None; }
        Some(self.lower(entity, decoder, quality).map(|plan| crate::program::OwnedConstructor::new(Constructor::SectionedSolid(plan))))
    }

    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.lower(entity, decoder, quality)?.evaluate()
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
    arc_map: Option<&ArcLengthMap>,
    pos: &PositionAlongDirectrix,
    fixed_axis_vertical: bool,
) -> Result<AlignmentFrame> {
    let station = pos.horizontal_station(arc_map);
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
        let right_3d = match right_candidate.try_normalize(tol::AXIS_MIN_LEN) {
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

    // PointByDistanceExpression offsets use the basis curve's tangent
    // frame, independent of the cross-section orientation and cant.
    let vertical_normal = base.tangent.cross(&(-base.right)).normalize();
    let point_up = if pos.linear { vertical_normal } else { up };
    let point_right = if pos.linear { base.right } else { right };
    let origin = base.origin
        + base.tangent * pos.offset_longitudinal
        + point_right * pos.offset_lateral
        + point_up * pos.offset_vertical;

    if pos.linear && (pos.axis.is_some() || pos.ref_direction.is_some()) {
        // IFC4x3 placement directions are given in the curve frame:
        // X along tangent, Y left of travel, Z vertical normal.
        let [_, y, axis] = crate::axis_projection::linear_placement_axes(
            [base.tangent, -base.right, vertical_normal],
            pos.axis,
            pos.ref_direction,
        )
        .ok_or_else(|| {
            Error::geometry(
                "IfcAxis2PlacementLinear Axis is parallel to its RefDirection".to_string(),
            )
        })?;
        // Profile +X is the placement's local +Y = Axis × RefDirection.
        right = y;
        up = axis;
    } else if pos.linear {
        // IFC4x3 positions the profile in the placement's YZ plane: profile
        // +X is local +Y (left of travel), profile +Y is local +Z (#7584).
        right = -right;
    }

    Ok(AlignmentFrame {
        origin,
        right,
        up,
        tangent: if pos.linear && (pos.axis.is_some() || pos.ref_direction.is_some()) {
            right.cross(&up).normalize()
        } else { base.tangent },
    })
}

/// `true` when `(right, up, tangent)` is a proper rotation, i.e. the profile
/// is placed without mirroring. The IFC4x1 right-of-travel frame is mirrored,
/// so its rings need the opposite winding to face outward.
fn is_proper(frame: &AlignmentFrame) -> bool {
    frame.right.cross(&frame.up).dot(&frame.tangent) > 0.0
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
    arc_map: Option<&ArcLengthMap>,
    quality: TessellationQuality,
) -> usize {
    let span = (b.distance_along - a.distance_along).abs();
    if span < 1e-9 {
        return 1;
    }
    let Some(curve) = alignment else {
        return 1; // Straight directrix: nothing to subdivide.
    };
    let s_a = a.horizontal_station(arc_map);
    let s_b = b.horizontal_station(arc_map);
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
    // Base subdivision count from the 2°-per-quad budget; scaled by quality
    // (higher quality → finer steps → more subdivisions). Medium reproduces
    // the historical `n.max(1).min(MAX_SUBDIVISIONS)` exactly.
    let n_base = (total_angle / MAX_ANGLE_STEP_RAD).ceil() as usize;
    scale_segments(n_base, 1, MAX_SUBDIVISIONS, quality)
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
        axis: lerp_direction(a.axis, b.axis, t),
        ref_direction: lerp_direction(a.ref_direction, b.ref_direction, t),
        linear: a.linear,
    }
}

fn lerp_direction(a: Option<Vector3<f64>>, b: Option<Vector3<f64>>, t: f64) -> Option<Vector3<f64>> {
    match (a, b) {
        (Some(a), Some(b)) => (a * (1.0 - t) + b * t).try_normalize(tol::DIRECTION_MIN_LEN).or(Some(a)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}
