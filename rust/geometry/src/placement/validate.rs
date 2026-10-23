// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! [`validate_chain`]: check a placement chain against a consumer's own
//! limits without composing it. The walk is the same as [`super::resolve_chain`]
//! (cycle-checked, uncapped); the rules a consumer adds are stated once here
//! instead of being re-derived at each site.

use super::chain::LinkKind;
use super::chain_walk::{climb, Climb, Frame};
use super::{Axis2Placement, PlacementError, PlacementResult};
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
    climb(&mut climbed, placement, decoder, false, false)?;
    if let Some((at, found)) = climbed.stopped_at {
        return Err(PlacementError::Unsupported { at, found });
    }
    for frame in &climbed.frames {
        let at = frame.entity.id;
        match frame.kind {
            LinkKind::Local => check_relative(frame, decoder, policy)?,
            LinkKind::Linear if policy.linear => {}
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
        .ok_or(PlacementError::Missing { at, attr: "RelativePlacement" })?;
    let rel = decoder
        .resolve_ref(attr)?
        .ok_or(PlacementError::Missing { at, attr: "RelativePlacement" })?;
    match rel.ifc_type {
        IfcType::IfcAxis2Placement3D if policy.strict_spatial => check_spatial(&rel, decoder),
        // Readable under the leaf rule too, so a validator refuses exactly
        // what `resolve_chain` would (malformed leaves are counted).
        IfcType::IfcAxis2Placement3D => Axis2Placement::read_3d(&rel, decoder).map(drop),
        IfcType::IfcAxis2Placement2D if policy.planar_relative => Axis2Placement::read_2d(&rel, decoder).map(drop),
        IfcType::IfcAxis2Placement2D => {
            Err(PlacementError::Policy { at: rel.id, rule: "IfcAxis2Placement2D is not accepted" })
        }
        found => Err(PlacementError::Unsupported { at: rel.id, found }),
    }
}

/// The ratios of `IfcDirection`/coordinates of `IfcCartesianPoint` in slot
/// `slot` of `placement`, `None` for `$`, refused unless exactly 3 numbers.
fn exact3(placement: &DecodedEntity, slot: usize, decoder: &mut EntityDecoder) -> PlacementResult<Option<[f64; 3]>> {
    let Some(attr) = placement.get(slot).filter(|attr| !attr.is_null()) else {
        return Ok(None);
    };
    let Some(record) = decoder.resolve_ref(attr)? else {
        return Ok(None);
    };
    let at = placement.id;
    let list = record
        .get(0)
        .and_then(|attr| attr.as_list())
        .filter(|list| list.len() == 3)
        .ok_or(PlacementError::Policy { at, rule: "placement point or direction must have exactly 3 components" })?;
    let mut out = [0.0; 3];
    for (slot, item) in out.iter_mut().zip(list) {
        *slot = item
            .as_float()
            .filter(|v| v.is_finite())
            .ok_or(PlacementError::Policy { at, rule: "placement component is not a finite number" })?;
    }
    Ok(Some(out))
}

fn check_spatial(rel: &DecodedEntity, decoder: &mut EntityDecoder) -> PlacementResult<()> {
    let at = rel.id;
    if exact3(rel, 0, decoder)?.is_none() {
        return Err(PlacementError::Missing { at, attr: "Location" });
    }
    let unit = |v: Option<[f64; 3]>| match v {
        Some(v) => nalgebra::Vector3::from(v)
            .try_normalize(0.0)
            .filter(|n| n.norm() > 0.0)
            .map(Some)
            .ok_or(PlacementError::Policy { at, rule: "placement direction is zero" }),
        None => Ok(None),
    };
    let axis = unit(exact3(rel, 1, decoder)?)?;
    let reference = unit(exact3(rel, 2, decoder)?)?;
    if let (Some(a), Some(r)) = (axis, reference) {
        if a.cross(&r).norm() <= 1e-12 {
            return Err(PlacementError::Policy { at, rule: "Axis is parallel to RefDirection" });
        }
    }
    Ok(())
}
