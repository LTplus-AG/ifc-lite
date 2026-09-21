// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{
    diagnostic, equation_direction, evaluate_segment, station_mapping, validate_numeric_alignment,
    validate_segment, LandXmlAlignment, LandXmlAlignmentProbe, LandXmlAlignmentSegment,
    LandXmlStationMapping, Result, EPSILON,
};

impl LandXmlAlignment {
    /// Maps physical distance to displayed station without conflating the two.
    pub fn station_at_distance(&self, distance: f64) -> Result<LandXmlStationMapping> {
        validate_numeric_alignment(self)?;
        if !distance.is_finite() || distance < -EPSILON || distance > self.length + EPSILON {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA201",
                "geometric distance is outside the alignment",
            ));
        }
        station_mapping(
            &self.source_id,
            self.sta_start,
            self.sta_start + distance.clamp(0.0, self.length),
            &self.station_equations,
        )
    }

    /// Returns every physical distance matching a displayed station. Empty is a station gap.
    pub fn distances_for_station(&self, station: f64) -> Result<Vec<f64>> {
        validate_numeric_alignment(self)?;
        self.distances_for_station_validated(station, None)
    }

    fn distances_for_station_validated(
        &self,
        station: f64,
        max_matches: Option<usize>,
    ) -> Result<Vec<f64>> {
        if !station.is_finite() {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA202",
                "station must be finite",
            ));
        }
        let mut boundaries = vec![self.sta_start];
        boundaries.extend(
            self.station_equations
                .iter()
                .map(|equation| equation.sta_internal),
        );
        boundaries.push(self.sta_start + self.length);
        let mut out: Vec<f64> = Vec::new();
        let mut direction = 1.0;
        for (index, window) in boundaries.windows(2).enumerate() {
            let display_start = if index == 0 {
                self.sta_start
            } else {
                self.station_equations[index - 1].sta_ahead
            };
            let candidate = window[0] + (station - display_start) / direction;
            if candidate >= window[0] - EPSILON && candidate <= window[1] + EPSILON {
                let distance = (candidate - self.sta_start).clamp(0.0, self.length);
                if out
                    .last()
                    .is_none_or(|previous| (distance - *previous).abs() > EPSILON)
                {
                    out.push(distance);
                    if max_matches.is_some_and(|maximum| out.len() > maximum) {
                        return Err(diagnostic(
                            &self.source_id,
                            "LXMLA230",
                            "station label has too many physical matches for an interactive probe",
                        ));
                    }
                }
            }
            if let Some(equation) = self.station_equations.get(index) {
                direction = equation_direction(equation);
            }
        }
        Ok(out)
    }

    /// Evaluates an authored primitive at a physical distance, never a mesh request.
    pub fn probe_at_distance(
        &self,
        distance: f64,
        offset_right: f64,
    ) -> Result<LandXmlAlignmentProbe> {
        validate_numeric_alignment(self)?;
        self.probe_at_distance_validated(distance, offset_right)
    }

    fn probe_at_distance_validated(
        &self,
        distance: f64,
        offset_right: f64,
    ) -> Result<LandXmlAlignmentProbe> {
        if !offset_right.is_finite() {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA203",
                "offset must be finite",
            ));
        }
        if !distance.is_finite() || distance < -EPSILON || distance > self.length + EPSILON {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA201",
                "geometric distance is outside the alignment",
            ));
        }
        let station = station_mapping(
            &self.source_id,
            self.sta_start,
            self.sta_start + distance.clamp(0.0, self.length),
            &self.station_equations,
        )?;
        let (segment, local) = self.segment_at_distance(distance)?;
        let (point, tangent) = evaluate_segment(segment, local)?;
        Ok(LandXmlAlignmentProbe {
            alignment_source_id: self.source_id.clone(),
            segment_source_id: segment.source_id.clone(),
            geometric_distance: distance.clamp(0.0, self.length),
            station,
            northing: point.northing - tangent.1 * offset_right,
            easting: point.easting + tangent.0 * offset_right,
            tangent_northing: tangent.0,
            tangent_easting: tangent.1,
        })
    }

    /// Resolves one displayed label, refusing duplicate labels rather than guessing.
    pub fn probe_at_station(
        &self,
        station: f64,
        offset_right: f64,
    ) -> Result<LandXmlAlignmentProbe> {
        validate_numeric_alignment(self)?;
        match self
            .distances_for_station_validated(station, None)?
            .as_slice()
        {
            [distance] => self.probe_at_distance_validated(*distance, offset_right),
            [] => Err(diagnostic(
                &self.source_id,
                "LXMLA204",
                "station is in a station equation gap",
            )),
            _ => Err(diagnostic(
                &self.source_id,
                "LXMLA205",
                "station label is duplicated by an equation",
            )),
        }
    }

    /// Evaluates a bounded number of displayed-station matches after one validation pass.
    pub fn probes_at_station(
        &self,
        station: f64,
        offset_right: f64,
        max_matches: usize,
    ) -> Result<Vec<LandXmlAlignmentProbe>> {
        if max_matches == 0 {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA230",
                "interactive station probe limit must be positive",
            ));
        }
        validate_numeric_alignment(self)?;
        self.distances_for_station_validated(station, Some(max_matches))?
            .into_iter()
            .map(|distance| self.probe_at_distance_validated(distance, offset_right))
            .collect()
    }

    fn segment_at_distance(&self, distance: f64) -> Result<(&LandXmlAlignmentSegment, f64)> {
        let mut start = 0.0;
        for (index, segment) in self.segments.iter().enumerate() {
            let length = validate_segment(segment)?;
            let end = start + length;
            if distance < end - EPSILON || index + 1 == self.segments.len() {
                return Ok((segment, (distance - start).clamp(0.0, length)));
            }
            start = end;
        }
        Err(diagnostic(
            &self.source_id,
            "LXMLA206",
            "no primitive covers geometric distance",
        ))
    }
}
