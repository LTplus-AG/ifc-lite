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

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::{Point3, Vector3};

#[path = "sectioned_mesh.rs"]
mod sectioned_mesh;
#[path = "sectioned_positions.rs"]
mod sectioned_positions;
use crate::alignment_arc_length::ArcLengthMap;
use sectioned_mesh::{
    clean_region, emit_caps, emit_side_walls, interpolate_section, place_section, same_topology,
    Section,
};
use sectioned_positions::PositionAlongDirectrix;

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
        quality: TessellationQuality,
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

        // Decode authored (section, position) pairs. A section is one region
        // per disjoint area of its profile (several for a composite, #7685).
        let mut authored: Vec<(Section, PositionAlongDirectrix)> =
            Vec::with_capacity(sections_list.len());
        for (sec_attr, pos_attr) in sections_list.iter().zip(positions_list.iter()) {
            let sec_id = sec_attr.as_entity_ref().ok_or_else(|| {
                Error::geometry("CrossSection must be an entity reference".to_string())
            })?;
            let sec_entity = decoder.decode_by_id(sec_id)?;
            let section: Section = self
                .profile_processor
                .process_regions(&sec_entity, decoder, quality)?
                .into_iter()
                .filter_map(clean_region)
                .collect();
            if section.is_empty() {
                continue; // Skip degenerate profiles.
            }
            let pos_id = pos_attr.as_entity_ref().ok_or_else(|| {
                Error::geometry("CrossSectionPosition must be an entity reference".to_string())
            })?;
            let pos_entity = decoder.decode_by_id(pos_id)?;
            let position =
                PositionAlongDirectrix::parse(&pos_entity, decoder, &directrix_entity)?;
            authored.push((section, position));
        }

        if authored.len() < 2 {
            return Err(Error::geometry(
                "IfcSectionedSolidHorizontal: <2 valid stations after filtering degenerate \
                 cross-sections — nothing to loft"
                    .to_string(),
            ));
        }
        let arc_map = if authored.iter().any(|(_, pos)| !pos.along_horizontal) {
            alignment.as_ref().map(ArcLengthMap::new)
        } else {
            None
        };
        // NaN-last total order (#7674): a NaN distance_along cannot panic the sort.
        authored.sort_by(|a, b| crate::cmp_f64_nan_last(a.1.distance_along, b.1.distance_along));

        // Walk authored pairs, subdividing intermediate stations
        // wherever the alignment curves significantly between them.
        let mut samples: Vec<(Section, PositionAlongDirectrix)> = Vec::new();
        samples.push(authored[0].clone());
        for i in 1..authored.len() {
            let (prev_prof, prev_pos) = (&authored[i - 1].0, authored[i - 1].1);
            let (this_prof, this_pos) = (&authored[i].0, authored[i].1);
            let n = subdivisions(&prev_pos, &this_pos, alignment.as_ref(), arc_map.as_ref(), quality);
            for k in 1..n {
                let t = k as f64 / n as f64;
                let interp_profile = interpolate_section(prev_prof, this_prof, t);
                let interp_pos = lerp_position(&prev_pos, &this_pos, t);
                samples.push((interp_profile, interp_pos));
            }
            samples.push(authored[i].clone());
        }

        // Place every ring of every sample in 3D using the alignment frame
        // plus the IfcDistanceExpression offsets.
        let mut rings_3d = Vec::with_capacity(samples.len());
        let mut frames: Vec<AlignmentFrame> = Vec::with_capacity(samples.len());
        for (section, pos) in &samples {
            let frame = compute_frame(alignment.as_ref(), arc_map.as_ref(), pos, fixed_axis_vertical)?;
            rings_3d.push(place_section(section, &frame));
            frames.push(frame);
        }

        // Build the mesh: start cap, side walls between consecutive
        // rings, end cap. Topology change (varying region or ring vertex
        // counts between adjacent samples) closes the current sub-sweep
        // and reopens the next one with a backwards-facing cap. The cap's shading
        // normal is the directrix tangent direction at that station so
        // flat-shaded renderers don't sample the side-wall normal.
        let mut mesh = Mesh::new();
        let flip = !is_proper(&frames[0]);
        emit_caps(&mut mesh, &samples[0].0, &rings_3d[0], -frames[0].tangent, flip)?;
        for i in 1..samples.len() {
            let (prev_profile, _) = &samples[i - 1];
            let (this_profile, _) = &samples[i];
            let prev_ring = &rings_3d[i - 1];
            let this_ring = &rings_3d[i];

            if same_topology(prev_profile, this_profile) {
                emit_side_walls(&mut mesh, this_profile, prev_ring, this_ring, flip);
            } else {
                // Topology change. Cap off the previous sub-sweep
                // (forward-facing) and reopen with a backwards-facing
                // cap on the new sub-sweep. (Only triggered by
                // authored topology changes — subdivision-introduced
                // sub-samples always match their neighbours.)
                emit_caps(&mut mesh, prev_profile, prev_ring, frames[i - 1].tangent, !flip)?;
                emit_caps(&mut mesh, this_profile, this_ring, -frames[i].tangent, flip)?;
            }
        }
        let last = samples.len() - 1;
        emit_caps(&mut mesh, &samples[last].0, &rings_3d[last], frames[last].tangent, !flip)?;

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
        let to_world = |v: Vector3<f64>| {
            base.tangent * v.x - base.right * v.y + vertical_normal * v.z
        };
        let axis = pos.axis.map(to_world).unwrap_or(vertical_normal);
        let x = pos.ref_direction.map(to_world).unwrap_or(base.tangent);
        let x = (x - axis * x.dot(&axis)).try_normalize(1e-12).unwrap_or(base.tangent);
        // Profile +X is the placement's local +Y = Axis × RefDirection.
        // Parallel Axis and RefDirection (or tangent) leave it undefined.
        right = axis.cross(&x).try_normalize(1e-12).ok_or_else(|| {
            Error::geometry(
                "IfcAxis2PlacementLinear Axis is parallel to its RefDirection".to_string(),
            )
        })?;
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
        (Some(a), Some(b)) => (a * (1.0 - t) + b * t).try_normalize(1e-12).or(Some(a)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}
