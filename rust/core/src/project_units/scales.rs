// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The file's length and plane-angle scales, resolved once (F3a, #7775).
//!
//! [`UnitScales`] is the scalar half of [`ProjectUnits`](super::ProjectUnits):
//! the multipliers geometry and the data readers apply to file numbers. It
//! moved here from `ifc-lite-processing`'s prepass so that core owns the one
//! resolution ladder and every crate consumes it.

use super::ProjectUnits;
use crate::decoder::EntityDecoder;
use crate::units::{
    extract_plane_angle_to_radians, resolve_length_unit, try_extract_length_unit_scale,
    try_extract_plane_angle_to_radians, LengthUnit,
};

/// The file's unit scales, resolved exactly once per parse.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UnitScales {
    /// Length unit → metres (1.0 for metre files, 0.001 for millimetre files).
    pub length_unit_scale: f64,
    /// Plane-angle unit → radians (1.0 for RADIAN files, π/180 for DEGREE).
    pub plane_angle_to_radians: f64,
    /// The `IFCPROJECT` express id the scales were resolved from, when found.
    pub project_id: Option<u32>,
    /// The unusable length-unit factor geometry must refuse (#7678); `length_unit_scale` is then data-only.
    pub length_unit_refused: Option<u32>,
}

impl UnitScales {
    /// The geometry scale: 1.0 for a refused unit, a finite placeholder no mesh uses (#7678).
    pub fn geometry_length_scale(&self) -> f64 {
        if self.length_unit_refused.is_some() { 1.0 } else { self.length_unit_scale }
    }

    /// The length unit as [`LengthUnit`]: the data reader's value (main's, an
    /// overflowing factor reading as infinity) plus the refusal geometry must
    /// follow. Never refuses itself.
    pub fn length_unit(&self) -> LengthUnit {
        LengthUnit { scale: self.length_unit_scale, unusable_factor: self.length_unit_refused }
    }

    /// Resolve BOTH scales against a COMPLETE entity index, with the data
    /// path's policy: an undecodable project or assignment leaves the metre
    /// and radian defaults, and an unusable length factor keeps main's value
    /// in `length_unit_scale` while flagging `length_unit_refused` (D13: data
    /// never refuses, geometry does).
    pub fn resolve_complete(decoder: &mut EntityDecoder, project_id: u32) -> Self {
        let unit = resolve_length_unit(decoder, project_id).ok();
        Self {
            length_unit_scale: unit.map_or(1.0, |unit| unit.scale),
            length_unit_refused: unit.and_then(|unit| unit.unusable_factor),
            plane_angle_to_radians: extract_plane_angle_to_radians(decoder, project_id).unwrap_or(1.0),
            project_id: Some(project_id),
        }
    }

    /// Resolve BOTH scales once, against the decoder's (possibly partial)
    /// entity index, with the documented fallback ladder:
    ///
    /// 1. `project_id_hint` (recorded by the scan) — O(1) decode via the index.
    /// 2. No hint? Locate `IFCPROJECT` with the one locator
    ///    ([`EntityDecoder::project_id`], a SIMD substring search: it is a
    ///    singleton and many exporters — IfcOpenShell, Revit — emit it near
    ///    the END of the file, after the scan's early-meta point).
    /// 3. Resolution chain incomplete on a PARTIAL index (streaming early-meta:
    ///    the IFCSIUNIT chain may sit past the scan point)? Re-resolve against a
    ///    freshly built FULL index rather than silently defaulting — a millimetre
    ///    model resolved as metres renders 1000× oversized.
    ///
    /// Per-element decoders are seeded from the result
    /// ([`EntityDecoder::seed_unit_scales`]) so the historic
    /// O(file)-scan-per-decoder stall class stays dead.
    pub fn resolve(content: &[u8], project_id_hint: Option<u32>, decoder: &mut EntityDecoder) -> Self {
        let project_id = project_id_hint.or_else(|| decoder.project_id());
        let Some(pid) = project_id else {
            return Self::default();
        };

        // Fast path: resolve on the caller's decoder/index. BOTH resolvers return
        // `None` (not a masked default) when their chain is incomplete on a partial
        // index, so an unresolved either-scale forces the full-index retry below
        // rather than silently shipping radians/metres (issue #1367).
        let length = try_extract_length_unit_scale(decoder, pid);
        let angle = try_extract_plane_angle_to_radians(decoder, pid);

        if let (Some(length_unit_scale), Some(plane_angle_to_radians)) = (length, angle) {
            return Self {
                length_unit_scale,
                plane_angle_to_radians,
                project_id,
                length_unit_refused: None,
            };
        }

        // Chain incomplete (partial index) — resolve against a full index.
        let full_index = crate::build_entity_index(content);
        let mut full_decoder = EntityDecoder::with_index(content, full_index);
        // The one unit policy (#7678): an unusable factor is a refusal, not metres.
        let unit = length
            .map(|scale| LengthUnit { scale, unusable_factor: None })
            .or_else(|| resolve_length_unit(&mut full_decoder, pid).ok());
        Self {
            length_unit_scale: unit.map_or(1.0, |unit| unit.scale),
            length_unit_refused: unit.and_then(|unit| unit.unusable_factor),
            plane_angle_to_radians: angle
                .or_else(|| extract_plane_angle_to_radians(&mut full_decoder, pid).ok())
                .unwrap_or(1.0),
            project_id,
        }
    }
}

impl Default for UnitScales {
    fn default() -> Self {
        Self {
            length_unit_scale: 1.0,
            plane_angle_to_radians: 1.0,
            project_id: None,
            length_unit_refused: None,
        }
    }
}

impl ProjectUnits {
    /// [`Self::resolve`] for the file's own project, located by the one
    /// locator ([`EntityDecoder::project_id`], the first `IFCPROJECT` in file
    /// order). A file without a project yields the empty table with metre and
    /// radian defaults.
    pub fn resolve_file(decoder: &mut EntityDecoder) -> Self {
        match decoder.project_id() {
            Some(project_id) => Self::resolve(decoder, project_id),
            None => Self::default(),
        }
    }

    /// The length and plane-angle scalars of the resolved project.
    ///
    /// They equal [`UnitScales::resolve`]'s on a complete index and carry the
    /// data path's value: main's, never a refusal. Geometry follows
    /// [`LengthUnit::for_geometry`] on [`Self::length_unit`].
    pub fn scales(&self) -> UnitScales {
        self.scales
    }

    /// Metres per file length unit (data path; see [`Self::scales`]).
    pub fn length_unit_scale(&self) -> f64 {
        self.scales.length_unit_scale
    }

    /// The length unit with the unusable-factor flag geometry must refuse on.
    pub fn length_unit(&self) -> LengthUnit {
        self.scales.length_unit()
    }

    /// Radians per file plane-angle unit.
    pub fn plane_angle_to_radians(&self) -> f64 {
        self.scales.plane_angle_to_radians
    }

    /// The `IFCPROJECT` these units were resolved from, if any.
    pub fn project_id(&self) -> Option<u32> {
        self.scales.project_id
    }
}
