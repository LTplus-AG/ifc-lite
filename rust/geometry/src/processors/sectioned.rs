// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcSectionedSolidHorizontal` — IFC4x1+ infrastructure entity used for
//! roads, bridges, alignments. A varying cross-section is lofted along a
//! directrix curve (typically an `IfcAlignmentCurve` with horizontal +
//! vertical segments).
//!
//! ## Scope of this processor
//!
//! Issue #828 asked for the entity to render at all instead of erroring
//! with "Unsupported representation type". The full feature would require
//! evaluating `IfcAlignmentCurve` (`IfcAlignment2DHorizontalSegment` arcs
//! and lines, `IfcAlignment2DVerSegLine`/`ParabolicArc` profiles) which is
//! a separate ~500-LOC effort. This processor ships the **lofting half**:
//!
//! - Decodes every `CrossSections[i]` profile via `ProfileProcessor` —
//!   `IfcArbitraryClosedProfileDef` over `IfcIndexedPolyCurve` (the form
//!   the issue's fixture uses) and every other parameterised profile we
//!   already support.
//! - Reads `CrossSectionPositions[i]` (`IfcDistanceExpression.DistanceAlong`)
//!   and treats those distances as arc length along a **straight directrix
//!   along the body's local +Y axis**. Curve evaluation is a TODO.
//! - Lofts each consecutive `(profile_i, profile_i+1)` pair via
//!   `extrude_profile_lofted`, then rotates / translates each segment so the
//!   sweep runs along body +Y (direction of travel) instead of along body
//!   +Z (the default direction `extrude_profile_lofted` produces).
//!
//! The resulting mesh has the correct **cross-section topology** and the
//! correct **arc-length parameterisation** but ignores horizontal/vertical
//! curvature. The bridge in `sectioned-solid.ifc` therefore renders as a
//! straight beam at the correct station offsets instead of following the
//! authored curve. That's wrong-looking but it's a strict improvement on
//! the previous "geometry doesn't render at all" state and exposes a hook
//! for the curve-evaluation work to plug into.

use crate::{
    extrusion::{apply_transform, extrude_profile_lofted},
    profiles::ProfileProcessor,
    Error, Mesh, Result,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use crate::router::GeometryProcessor;

/// Routes `IfcSectionedSolidHorizontal` to a cross-section-loft pipeline.
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
        //   0: Directrix                    (IfcCurve subtype)
        //   1: CrossSections                (LIST of IfcProfileDef)
        //   2: CrossSectionPositions        (LIST of IfcDistanceExpression)
        //   3: FixedAxisVertical            (BOOL)
        //
        // We ignore attrs 0 and 3 in this MVP (see module docstring).
        let sections_attr = entity.get(1).ok_or_else(|| {
            Error::geometry("IfcSectionedSolidHorizontal missing CrossSections".to_string())
        })?;
        let sections_list = sections_attr
            .as_list()
            .ok_or_else(|| Error::geometry("CrossSections must be a list".to_string()))?;

        let positions_attr = entity.get(2).ok_or_else(|| {
            Error::geometry(
                "IfcSectionedSolidHorizontal missing CrossSectionPositions".to_string(),
            )
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

        // Decode every profile + distance into one parallel list so we can
        // sort by distance (the IFC spec allows the positions to be in any
        // order, but lofting only works pairwise on sorted stations).
        let mut stations: Vec<(crate::Profile2D, f64)> =
            Vec::with_capacity(sections_list.len());
        for (sec_attr, pos_attr) in sections_list.iter().zip(positions_list.iter()) {
            let sec_id = sec_attr
                .as_entity_ref()
                .ok_or_else(|| Error::geometry("CrossSection must be an entity ref".to_string()))?;
            let sec_entity = decoder.decode_by_id(sec_id)?;
            let profile = self.profile_processor.process(&sec_entity, decoder)?;
            if profile.outer.len() < 3 {
                // Skip degenerate sections (≤2 points). Per IFC the profile
                // must be a closed planar region; <3 points can't loft.
                continue;
            }

            let pos_id = pos_attr.as_entity_ref().ok_or_else(|| {
                Error::geometry("CrossSectionPosition must be an entity ref".to_string())
            })?;
            let pos_entity = decoder.decode_by_id(pos_id)?;
            // IfcDistanceExpression[0] = DistanceAlong (IfcLengthMeasure).
            // Required attribute per the IFC schema.
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

        // Sort by station (DistanceAlong). Stable so equal-distance ties
        // keep their authoring order (rare — and the loft segment between
        // identical-distance neighbours produces a zero-thickness slab that
        // we filter below).
        stations.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

        // Loft consecutive pairs. `extrude_profile_lofted` produces a closed
        // solid (start cap + end cap + side walls) between two profiles
        // along +Z by `depth`. We then rotate/translate so the sweep runs
        // along body +Y, with the start cap landing at the segment's
        // `distance_start` station.
        //
        // Cap-side note: each segment carries its own start + end cap. For
        // adjacent segments this means the interior cap appears twice (once
        // as segment[i].end_cap, once as segment[i+1].start_cap) at the
        // same plane. The duplicates are coincident, not interpenetrating;
        // they cost extra triangles but don't visibly affect the shaded
        // result. Removing them would require a custom side-wall-only
        // loft helper; a TODO for the curve-eval follow-up.
        let mut combined = Mesh::new();
        for window in stations.windows(2) {
            let (start_profile, d_start) = &window[0];
            let (end_profile, d_end) = &window[1];
            let depth = d_end - d_start;
            if depth <= 1e-9 {
                continue;
            }

            // `extrude_profile_lofted` extrudes along local +Z. We want the
            // sweep to run along body +Y (direction of travel for the
            // horizontal sectioned solid), and the cross-section's local
            // (X, Y) to map to body (X, Z) — i.e. profile-Y is "up".
            //
            // Transform matrix takes lofted-mesh coords (px, py, pz) and
            // maps them to body coords (px, pz + d_start, py):
            //
            //     ┌                                       ┐
            //     │ 1   0   0   0                         │
            //     │ 0   0   1   d_start                   │
            //     │ 0   1   0   0                         │
            //     │ 0   0   0   1                         │
            //     └                                       ┘
            //
            // i.e. swap the Y and Z rows of the rotation block, and add
            // `d_start` along Y so consecutive segments stitch.
            let mut transform = Matrix4::zeros();
            transform[(0, 0)] = 1.0;
            transform[(1, 2)] = 1.0; // lofted Z (sweep direction) → body Y
            transform[(2, 1)] = 1.0; // lofted Y (profile vertical) → body Z
            transform[(3, 3)] = 1.0;
            transform[(1, 3)] = *d_start; // segment start station

            let segment = extrude_profile_lofted(start_profile, end_profile, depth, None)?;
            let mut placed = segment;
            apply_transform(&mut placed, &transform);
            combined.merge(&placed);
        }

        Ok(combined)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcSectionedSolidHorizontal]
    }
}
