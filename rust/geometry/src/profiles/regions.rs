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
//! [`ProfileProcessor::process_regions`] is the walk solid builders use. It is
//! a fan-out walk (a composite may list one sub-composite many times), so the
//! areas of composites are charged against a per-SOLID budget of areas and
//! ring points, and a multi-region sweep is capped on the vertices it would
//! place before it is built (#7747 review). The
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
        self.regions_with_depth(profile, decoder, 0, false)
    }

    /// Arm the composite work budgets (4096 areas and 65 536 ring points of
    /// composite sub-profiles) for ONE solid. Solid builders call this once
    /// before the solid's [`process_regions`](Self::process_regions) calls, so
    /// every one of them (each sectioned station, a tapered start and end)
    /// draws on the same budget. [`process`](Self::process) arms it itself.
    /// A new processor starts armed.
    pub fn arm_solid_budget(&self) {
        self.region_budget.arm(MAX_PROFILE_REGIONS);
        self.point_budget.arm(MAX_PROFILE_POINTS);
    }

    /// [`process_regions`](Self::process_regions) under the shared
    /// `MAX_PROFILE_DEPTH` nesting cap (one path's length) and, for areas of
    /// a composite (`in_composite`), the solid's region and point budgets (the
    /// walk's fan-out). A profile outside any composite is not charged: its
    /// size is the file's own, as on base.
    pub(super) fn regions_with_depth(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        in_composite: bool,
    ) -> Result<Vec<Profile2D>> {
        if depth > MAX_PROFILE_DEPTH {
            return Err(profile_depth_error(profile, depth));
        }
        match profile.ifc_type {
            IfcType::IfcDerivedProfileDef | IfcType::IfcMirroredProfileDef => {
                let parent = derived_parent(profile, decoder)?;
                let mut regions = self.regions_with_depth(&parent, decoder, depth + 1, in_composite)?;
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
                    regions.extend(self.regions_with_depth(sub_profile, decoder, depth + 1, true)?);
                }
                Ok(regions)
            }
            _ if !in_composite => Ok(vec![self.process_with_depth(profile, decoder, depth)?]),
            _ => {
                let budget = &self.region_budget;
                if !budget.spend(1) {
                    return Err(Error::geometry(format!(
                        "Composite profile exceeds {MAX_PROFILE_REGIONS} regions at #{}",
                        profile.id
                    )));
                }
                let region = self.process_with_depth(profile, decoder, depth)?;
                let points = region_points(&region);
                let budget = &self.point_budget;
                if !budget.spend(u32::try_from(points).unwrap_or(u32::MAX)) {
                    return Err(Error::geometry(format!(
                        "Composite profile exceeds {MAX_PROFILE_POINTS} points at #{}",
                        profile.id
                    )));
                }
                Ok(vec![region])
            }
        }
    }
}

/// Composite areas one SOLID may draw on (every station of a sectioned solid,
/// both ends of a tapered one).
///
/// `MAX_PROFILE_DEPTH` bounds one path; these bound the walk. A composite that
/// lists the same sub-composite `k` times, `d` levels deep, is `k^d` areas
/// from a file of a few KB (k = 10, d = 6 was 12 M triangles and 2.5 GB).
/// Nothing in it is cyclic or failing, so neither the depth cap nor a visited
/// set (which would drop real, repeated areas) sees it. The router reports a
/// refused item as unsupported (D3). Real sections have tens of areas.
pub(crate) const MAX_PROFILE_REGIONS: u32 = 4096;

/// Ring points (outer plus holes) all composite areas of one solid may have:
/// the work unit, since every point is swept. 65 536 is several hundred
/// detailed areas; refused before any solid is built.
pub(crate) const MAX_PROFILE_POINTS: u32 = 1 << 16;

/// Ring vertices a sweep may place when it sweeps rings base did not (#7685):
/// profile points times revolution steps, loft stations or directrix samples.
/// The builders' multiplier (up to 96 steps for a full revolution, 256
/// subdivisions per station pair) sits outside the profile walk, so it is
/// checked before the mesh is built. 131 072 placed vertices is about 260 k
/// triangles. The rings that are new are a composite's further areas and any
/// hole ring: an `IfcArbitraryProfileDefWithVoids` can list one `IfcCircle` as
/// a void tens of thousands of times at a few bytes each. A single outer ring
/// is not capped: base swept exactly that, and its size is the file's own.
pub(crate) const MAX_SWEEP_VERTICES: usize = 1 << 17;

/// `true` when sweeping `regions` places rings base did not: several areas,
/// or any hole.
pub(crate) fn sweeps_new_rings(regions: &[Profile2D]) -> bool {
    regions.len() > 1 || regions.iter().any(|r| !r.holes.is_empty())
}

/// Refuse a sweep of new rings (`new_rings`, see [`sweeps_new_rings`]) that
/// would place more than [`MAX_SWEEP_VERTICES`] ring vertices. The router
/// records the refused item as unsupported (D3).
pub(crate) fn check_sweep_vertices(placed: usize, new_rings: bool, id: u32) -> Result<()> {
    if new_rings && placed > MAX_SWEEP_VERTICES {
        return Err(Error::geometry(format!(
            "Sweep would place {placed} ring vertices, over {MAX_SWEEP_VERTICES}, at #{id}"
        )));
    }
    Ok(())
}

/// Ring points of `region`: its outer ring and every hole.
pub(crate) fn region_points(region: &Profile2D) -> usize {
    region.outer.len() + region.holes.iter().map(Vec::len).sum::<usize>()
}

/// A count-down work budget, armed once per solid.
pub(super) struct WorkBudget(Cell<u32>);

impl WorkBudget {
    pub(super) fn new(limit: u32) -> Self {
        Self(Cell::new(limit))
    }

    pub(super) fn arm(&self, limit: u32) {
        self.0.set(limit);
    }

    /// Charge `units`; `false` once the budget is exhausted.
    pub(super) fn spend(&self, units: u32) -> bool {
        match self.0.get().checked_sub(units) {
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
