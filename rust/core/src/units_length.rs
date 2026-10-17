// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one length-unit admission policy (#7678, CORE-15), split out of
//! `units.rs` to keep that module inside its module-size budget.

use super::extract_length_unit_scale;
use crate::decoder::EntityDecoder;
use crate::error::{Error, Result};

/// A project's length unit under input admission (#7678, CORE-15): the one
/// home of the "unusable unit factor" policy every caller follows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LengthUnit {
    /// Metres per file unit as the data model reads it, and as main did: an
    /// overflowing declared factor reads as infinity, any other unusable one
    /// as metres. Data readers and exporters keep this value.
    pub scale: f64,
    /// The `IFCMEASUREWITHUNIT` holding a declared conversion factor that is
    /// not a positive finite number. Geometry must refuse to mesh against it
    /// (fail closed and count it): no metre scale is right for it.
    pub unusable_factor: Option<u32>,
}

impl LengthUnit {
    /// The scale geometry may mesh with, or the refusal of the factor.
    pub fn for_geometry(self) -> Result<f64> {
        match self.unusable_factor {
            Some(factor) => Err(Error::UnusableUnitFactor { factor, overflowed: !self.scale.is_finite() }),
            None => Ok(self.scale),
        }
    }
}

/// [`extract_length_unit_scale`] with its unusable-factor refusal turned into
/// a [`LengthUnit`], so a data reader keeps main's value and a geometry reader
/// refuses. Any other error (an undecodable project or assignment) is returned
/// as before; callers keep their existing defaults for it.
pub fn resolve_length_unit(decoder: &mut EntityDecoder, project_id: u32) -> Result<LengthUnit> {
    match extract_length_unit_scale(decoder, project_id) {
        Ok(scale) => Ok(LengthUnit { scale, unusable_factor: None }),
        Err(Error::UnusableUnitFactor { factor, overflowed }) => Ok(LengthUnit {
            scale: if overflowed { f64::INFINITY } else { 1.0 },
            unusable_factor: Some(factor),
        }),
        Err(error) => Err(error),
    }
}

