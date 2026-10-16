// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Profile REGIONS: the disjoint areas a profile definition describes.
//!
//! Every profile type is one area (an outer ring plus the holes inside it)
//! except `IfcCompositeProfileDef`, whose `Profiles` are separate areas:
//! double angles, built-up and compound sections, twin tubes, wall layers.
//! None of them is a hole of another, and each keeps its own holes. They used
//! to be folded into the first sub-profile as holes (PROC-15, #7685), which
//! gave a second area outside the first inward-facing walls and a dropped or
//! stray cap, and lost every later sub-profile's holes.
//!
//! [`ProfileProcessor::process_regions`] is the walk solid builders use. The
//! single-[`Profile2D`] [`ProfileProcessor::process`] stays for outline
//! consumers and returns a multi-region composite as one outline (see
//! [`flatten_regions`]).

use super::{ProfileProcessor, MAX_PROFILE_DEPTH};
use std::cell::Cell;
use crate::profile::Profile2D;
use crate::tessellation::TessellationQuality;
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, ProfileCategory};

impl ProfileProcessor {
    /// Process `profile` into its disjoint areas, each an outer ring plus
    /// the holes inside it. One region for every profile type but
    /// `IfcCompositeProfileDef` (and derived or mirrored profiles of one),
    /// which yields one region per sub-profile, in authored order.
    ///
    /// Solid builders (extrusion, revolution, loft, sweep) call this and build
    /// one solid per region; see the module docs for why a composite cannot
    /// be one outer ring with holes.
    pub fn process_regions(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<Vec<Profile2D>> {
        self.set_tessellation_quality(quality);
        self.regions_with_depth(profile, decoder, 0)
    }

    /// [`process_regions`](Self::process_regions) under the shared
    /// `MAX_PROFILE_DEPTH` nesting cap (one path's length; the composite fan
    /// out is bounded by the file's own list sizes).
    pub(super) fn regions_with_depth(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Profile2D>> {
        if depth > MAX_PROFILE_DEPTH {
            return Err(profile_depth_error(profile, depth));
        }
        match profile.ifc_type {
            IfcType::IfcDerivedProfileDef | IfcType::IfcMirroredProfileDef => {
                let parent = derived_parent(profile, decoder)?;
                let mut regions = self.regions_with_depth(&parent, decoder, depth + 1)?;
                for region in &mut regions {
                    self.apply_derived_operator(profile, decoder, region)?;
                }
                Ok(regions)
            }
            _ if self.schema.profile_category(&profile.ifc_type)
                == Some(ProfileCategory::Composite) =>
            {
                // IfcCompositeProfileDef: ProfileType, ProfileName, Profiles, Label
                let profiles_attr = profile.get(2).ok_or_else(|| {
                    Error::geometry("Composite profile missing Profiles".to_string())
                })?;
                let sub_profiles = decoder.resolve_ref_list(profiles_attr)?;
                if sub_profiles.is_empty() {
                    return Err(Error::geometry(
                        "Composite profile has no sub-profiles".to_string(),
                    ));
                }
                let mut regions = Vec::with_capacity(sub_profiles.len());
                for sub_profile in &sub_profiles {
                    regions.extend(self.regions_with_depth(sub_profile, decoder, depth + 1)?);
                }
                Ok(regions)
            }
            _ => {
                let budget = &self.region_budget;
                if !budget.spend() {
                    return Err(Error::geometry(format!(
                        "Composite profile exceeds {MAX_PROFILE_REGIONS} regions at #{}",
                        profile.id
                    )));
                }
                Ok(vec![self.process_with_depth(profile, decoder, depth)?])
            }
        }
    }
}

/// Leaf regions one entry call may produce.
///
/// `MAX_PROFILE_DEPTH` bounds one path; this bounds the walk. A composite that
/// lists the same sub-composite `k` times, `d` levels deep, is `k^d` leaf
/// regions from a file of a few KB (k = 10, d = 6 was 12 M triangles and
/// 2.5 GB), and every region becomes a solid. Nothing in it is cyclic or
/// failing, so neither the depth cap nor a visited set (which would drop real,
/// repeated areas) sees it. 4096 areas is far above any real section (a wall
/// build-up or a built-up girder has tens) and refuses the fan-out before the
/// work is done; the router then reports the item as unsupported (D3).
pub(crate) const MAX_PROFILE_REGIONS: u32 = 4096;

/// A count-down work budget, armed at each entry call.
pub(super) struct WorkBudget(Cell<u32>);

impl WorkBudget {
    pub(super) fn new(limit: u32) -> Self {
        Self(Cell::new(limit))
    }

    pub(super) fn arm(&self, limit: u32) {
        self.0.set(limit);
    }

    /// Charge one unit; `false` once the budget is exhausted.
    pub(super) fn spend(&self) -> bool {
        match self.0.get().checked_sub(1) {
            Some(left) => {
                self.0.set(left);
                true
            }
            None => false,
        }
    }
}

/// The refusal when a profile nests past `MAX_PROFILE_DEPTH`, shared by
/// [`ProfileProcessor::process`] and [`ProfileProcessor::process_regions`].
pub(super) fn profile_depth_error(profile: &DecodedEntity, depth: u32) -> Error {
    Error::geometry(format!(
        "Profile nesting depth {} exceeds limit {} at #{}",
        depth, MAX_PROFILE_DEPTH, profile.id
    ))
}

/// `ParentProfile` (attribute 2) of an `IfcDerivedProfileDef` /
/// `IfcMirroredProfileDef`.
pub(super) fn derived_parent(
    profile: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<DecodedEntity> {
    let parent_attr = profile
        .get(2)
        .ok_or_else(|| Error::geometry("Derived profile missing ParentProfile".to_string()))?;
    decoder
        .resolve_ref(parent_attr)?
        .ok_or_else(|| Error::geometry("Derived profile ParentProfile not found".to_string()))
}

/// Collapse `regions` into the one [`Profile2D`] that
/// [`ProfileProcessor::process`] returns. One region is returned as is.
/// Several become an OUTLINE: the first region's outer ring, with every
/// other ring (each region's holes, and the later regions' outer rings) in
/// `holes`. That is every boundary the profile has, which is what outline
/// consumers (2D drawing projection) draw, but it is not a valid solid
/// section: build solids from [`ProfileProcessor::process_regions`].
pub(super) fn flatten_regions(regions: Vec<Profile2D>) -> Profile2D {
    let mut regions = regions.into_iter();
    let Some(mut result) = regions.next() else {
        return Profile2D::new(Vec::new());
    };
    for region in regions {
        result.add_hole(region.outer);
        result.holes.extend(region.holes);
    }
    result
}
