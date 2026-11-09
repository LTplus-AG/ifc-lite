// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Two reads of the model's geographic placement that are not a coordinate
//! operation: `IfcSite.RefLatitude` / `RefLongitude` / `RefElevation`, and the
//! model context's `TrueNorth`.
//!
//! The site read is the one the legacy georeferencing fallback
//! (`GeoRefExtractor::extract_from_site`) uses, exposed so a consumer that
//! needs the site location even when an `IfcMapConversion` exists (an earth
//! anchor point) reads the same numbers. `TrueNorth` had no reader outside the
//! map-conversion STEP rewrite, whose refusal policy is its own.

use super::georef_parse::{compound_angle_has_literal_negative_zero, compound_plane_angle_to_degrees};
use crate::decoder::EntityDecoder;
use crate::error::Result;
use crate::parser::{keyword_eq, EntityScanner};
use crate::slot;

/// `IfcSite`'s reference location.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SiteRefLocation {
    /// WGS84 degrees, north positive.
    pub latitude: f64,
    /// WGS84 degrees, east positive.
    pub longitude: f64,
    /// `RefElevation` as authored, in the file's length unit; `0.0` when absent.
    pub elevation: f64,
}

/// The reference location of site `site_id`, or `None` when it lacks a
/// readable latitude or longitude.
pub fn site_ref_location(decoder: &mut EntityDecoder, site_id: u32) -> Result<Option<SiteRefLocation>> {
    let site = decoder.decode_by_id(site_id)?;
    let latitude = compound_plane_angle_to_degrees(&site, slot::IfcSite::REF_LATITUDE.index());
    let longitude = compound_plane_angle_to_degrees(&site, slot::IfcSite::REF_LONGITUDE.index());
    let (Some(mut latitude), Some(mut longitude)) = (latitude, longitude) else {
        return Ok(None);
    };
    // The `-0` leniency (TS parity, see `compoundPlaneAngleToDecimalDegrees`
    // in `georef-extractor.ts`): a writer that signs a zero-magnitude
    // component of the compound angle (e.g. `(-0, 30, 0)` for 0°30'S)
    // survives only via the entity's RAW record bytes, because the shared
    // tokenizer parses `-0` as an `i64` with no negative zero. Re-scanning
    // this one attribute pair recovers the sign without touching the hot
    // tokenizer.
    if let Some(bytes) = decoder.get_raw_bytes(site_id) {
        if latitude >= 0.0 && compound_angle_has_literal_negative_zero(bytes, slot::IfcSite::REF_LATITUDE.index()) {
            latitude = -latitude;
        }
        if longitude >= 0.0 && compound_angle_has_literal_negative_zero(bytes, slot::IfcSite::REF_LONGITUDE.index()) {
            longitude = -longitude;
        }
    }
    let elevation = site.real_at(slot::IfcSite::REF_ELEVATION).unwrap_or(0.0);
    Ok(Some(SiteRefLocation { latitude, longitude, elevation }))
}

/// The model context's `TrueNorth`: the unit XY direction of true north in
/// the project's world coordinates.
///
/// Read from the first `IfcGeometricRepresentationContext` (not a
/// sub-context) whose `ContextType` is `Model`, else the first context. `None`
/// when that context has no `TrueNorth`, or it is not a finite, non-zero
/// `IfcDirection` with two or three ratios; IFC then means +Y, which the
/// caller supplies. A three-ratio direction keeps its XY part.
///
/// `decoder` must be over `content`; pass one that already holds an entity
/// index, or the direction lookup builds one.
pub fn model_true_north(content: &[u8], decoder: &mut EntityDecoder) -> Option<[f64; 2]> {
    let mut scanner = EntityScanner::new(content);
    let mut chosen: Option<u32> = None;
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !keyword_eq(type_name, "IFCGEOMETRICREPRESENTATIONCONTEXT") {
            continue;
        }
        let Ok(context) = decoder.decode_at_with_id(id, start, end) else { continue };
        let is_model = context
            .string_at(slot::IfcGeometricRepresentationContext::CONTEXT_TYPE)
            .is_some_and(|t| t.eq_ignore_ascii_case("model"));
        let north = context.ref_at(slot::IfcGeometricRepresentationContext::TRUE_NORTH);
        if chosen.is_none() || is_model {
            chosen = Some(north.unwrap_or(0));
        }
        if is_model {
            break;
        }
    }
    let direction = decoder.decode_by_id(chosen.filter(|&id| id != 0)?).ok()?;
    let ratios = direction.list_at(slot::IfcDirection::DIRECTION_RATIOS)?;
    if !(2..=3).contains(&ratios.len()) {
        return None;
    }
    unit_xy(ratios[0].as_float()?, ratios[1].as_float()?)
}

/// `(x, y)` scaled to unit length, or `None` when its length is zero or not
/// finite. The normalisation [`model_true_north`] applies to a `TrueNorth`,
/// shared with callers that turn another XY direction (a map conversion's
/// grid north) into a north.
pub fn unit_xy(x: f64, y: f64) -> Option<[f64; 2]> {
    let length = x.hypot(y);
    (length.is_finite() && length > 0.0).then(|| [x / length, y / length])
}
