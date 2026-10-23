// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! [`validate_chain`]: check a placement chain against a consumer's own
//! limits without composing it. The walk is the same as [`super::resolve_chain`]
//! (cycle-checked, uncapped); the rules a consumer adds are stated once here
//! instead of being re-derived at each site.

use super::chain::LinkKind;
use super::chain_walk::{climb, Climb, Frame};
use super::{missing, unsupported, Axis2Placement, PlacementError, PlacementResult};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

/// What a consumer accepts in a chain. All `false` is the strictest
/// `IfcLocalPlacement`-only, 3D-only chain.
#[derive(Debug, Clone, Copy, Default)]
pub struct ChainPolicy {
    /// Accept `IfcGridPlacement` links.
    pub grid: bool,
    /// Accept `IfcLinearPlacement` links.
    pub linear: bool,
    /// Accept an `IfcAxis2Placement2D` as `RelativePlacement`.
    pub planar_relative: bool,
    /// The alignment and export-preflight rule: every 3D `RelativePlacement`
    /// has exactly 3 location coordinates, non-zero directions of exactly 3
    /// ratios, and an Axis that is not parallel to its RefDirection.
    pub strict_spatial: bool,
}

/// Walk `placement` up to the root and check every link against `policy`.
/// A broken rule is [`PlacementError::Policy`], a consumer's limit rather
/// than bad input, so it is not counted as a refused record.
pub fn validate_chain(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
    policy: &ChainPolicy,
) -> PlacementResult<()> {
    let mut climbed = Climb::new();
    climb(&mut climbed, placement, decoder, false, false, None)?;
    if let Some((at, found)) = climbed.stopped_at {
        return Err(unsupported(decoder, at, found));
    }
    check_frames(&climbed.frames, decoder, policy)
}

pub(super) fn check_frames(frames: &[Frame], decoder: &mut EntityDecoder, policy: &ChainPolicy) -> PlacementResult<()> {
    for frame in frames {
        let at = frame.entity.id;
        match frame.kind {
            LinkKind::Local => check_relative(frame, decoder, policy)?,
            LinkKind::Linear if policy.linear => super::linear::validate_source(&frame.entity, decoder)?,
            LinkKind::Grid if policy.grid => {}
            LinkKind::Linear => return Err(PlacementError::Policy { at, rule: "IfcLinearPlacement is not accepted" }),
            LinkKind::Grid => return Err(PlacementError::Policy { at, rule: "IfcGridPlacement is not accepted" }),
        }
    }
    Ok(())
}

fn check_relative(frame: &Frame, decoder: &mut EntityDecoder, policy: &ChainPolicy) -> PlacementResult<()> {
    let at = frame.entity.id;
    let attr = frame
        .entity
        .get(1)
        .filter(|attr| !attr.is_null())
        .ok_or_else(|| missing(decoder, at, "RelativePlacement"))?;
    let rel = decoder
        .resolve_ref(attr)?
        .ok_or_else(|| missing(decoder, at, "RelativePlacement"))?;
    match rel.ifc_type {
        IfcType::IfcAxis2Placement3D if policy.strict_spatial => validate_spatial_frame(&rel, decoder),
        // Readable under the leaf rule too, so a validator refuses exactly
        // what `resolve_chain` would (malformed leaves are counted).
        IfcType::IfcAxis2Placement3D => Axis2Placement::read_3d(&rel, decoder).map(drop),
        IfcType::IfcAxis2Placement2D if policy.planar_relative => Axis2Placement::read_2d(&rel, decoder).map(drop),
        IfcType::IfcAxis2Placement2D => {
            Err(PlacementError::Policy { at: rel.id, rule: "IfcAxis2Placement2D is not accepted" })
        }
        found => Err(unsupported(decoder, rel.id, found)),
    }
}

/// Validate an `IfcAxis2Placement3D` under the strict spatial policy.
///
/// Strict consumers add arity/degeneracy constraints AFTER the canonical
/// typed leaf read. Do not bypass that read: unreadable input is refused and
/// counted even when its attr0 happens to look like three coordinates (#7779).
pub fn validate_spatial_frame(rel: &DecodedEntity, decoder: &mut EntityDecoder) -> PlacementResult<()> {
    let frame = Axis2Placement::read_3d(rel, decoder)?;
    for slot in 0..3 {
        if let Some(record) = decoder.resolve_optional(rel, slot)? {
            if record.get_list(0).is_none_or(|list| list.len() != 3) {
                return Err(PlacementError::Policy { at: rel.id, rule: "placement point or direction must have exactly 3 components" });
            }
        }
    }
    let unit = |v: [f64; 3]| {
        let v = nalgebra::Vector3::from(v);
        let norm = v.norm();
        if !norm.is_finite() || norm == 0.0 {
            return Err(PlacementError::Policy { at: rel.id, rule: "placement direction is zero or unbounded" });
        }
        Ok(v / norm)
    };
    // Defaults participate in the WR too. Explicit +X Axis with omitted
    // RefDirection (default +X) is parallel, just like two explicit +X axes.
    let axis = unit(frame.axis.unwrap_or(super::Z))?;
    let reference = unit(frame.ref_direction.unwrap_or(super::X))?;
    if axis.cross(&reference).norm() <= 1e-12 {
        return Err(PlacementError::Policy { at: rel.id, rule: "Axis is parallel to RefDirection" });
    }
    Ok(())
}
