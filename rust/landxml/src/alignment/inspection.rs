// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Station-indexed source inspection without inventing transition values.

use super::{
    LandXmlAlignment, LandXmlCantStation, LandXmlNumericDiagnostic, LandXmlStationMapping,
    LandXmlSuperelevation,
};

/// The bracketing authored cant values at one physical alignment distance.
///
/// LandXML preserves producer-specific transition semantics. This type exposes
/// the exact neighboring records instead of silently interpolating one.
#[derive(Clone, Debug, PartialEq)]
pub struct LandXmlCantProbe {
    pub internal_station: f64,
    pub station: LandXmlStationMapping,
    pub previous: Option<LandXmlCantStation>,
    pub next: Option<LandXmlCantStation>,
}

impl LandXmlAlignment {
    /// Inspects the exact authored CantStation records bracketing a physical
    /// distance. Displayed station equations do not alter Cant's internal
    /// station axis.
    pub fn cant_at_distance(
        &self,
        distance: f64,
    ) -> Result<Option<LandXmlCantProbe>, LandXmlNumericDiagnostic> {
        let station = self.station_at_distance(distance)?;
        let Some(cant) = &self.cant else {
            return Ok(None);
        };
        let internal_station = self.sta_start + distance;
        let split = cant
            .stations
            .partition_point(|candidate| candidate.station <= internal_station);
        Ok(Some(LandXmlCantProbe {
            internal_station,
            station,
            previous: split
                .checked_sub(1)
                .and_then(|index| cant.stations.get(index))
                .cloned(),
            next: cant.stations.get(split).cloned(),
        }))
    }

    /// Returns all Superelevation blocks whose declared station range includes
    /// the physical distance. Missing bounds are open bounds, never guessed
    /// from a sibling event's textual value.
    pub fn superelevations_at_distance(
        &self,
        distance: f64,
    ) -> Result<Vec<&LandXmlSuperelevation>, LandXmlNumericDiagnostic> {
        self.station_at_distance(distance)?;
        let internal_station = self.sta_start + distance;
        Ok(self
            .superelevations
            .iter()
            .filter(|value| {
                value
                    .sta_start
                    .is_none_or(|start| internal_station >= start)
                    && value.sta_end.is_none_or(|end| internal_station <= end)
            })
            .collect())
    }
}
