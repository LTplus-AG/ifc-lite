/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

impl Parser<'_> {
    pub(super) fn finish_capture(&mut self) -> Result<()> {
        let capture = self.capture.take().expect("capture checked");
        let surface = self
            .surface
            .as_mut()
            .ok_or_else(|| error(Code::InvalidSemantic, "geometry outside Surface"))?;
        match capture {
            Capture::Point { id, text, .. } => {
                if self.points_seen >= self.limits.max_points {
                    return Err(error(Code::LimitExceeded, "point limit exceeded"));
                }
                if !surface.ids.insert(id.clone()) {
                    return Err(error(Code::InvalidSemantic, "duplicate point id"));
                }
                let values = triple(&text, "point")?;
                surface.points.push(LandXmlPoint {
                    source_id: LandXmlSourceId(String::new()),
                    id,
                    northing: values[0],
                    easting: values[1],
                    elevation: values[2],
                });
                self.points_seen += 1;
            }
            Capture::Face { text, hidden, .. } => {
                if self.faces_seen >= self.limits.max_faces {
                    return Err(error(Code::LimitExceeded, "face limit exceeded"));
                }
                self.references = self
                    .references
                    .checked_add(3)
                    .ok_or_else(|| error(Code::LimitExceeded, "reference limit exceeded"))?;
                if self.references > self.limits.max_references {
                    return Err(error(Code::LimitExceeded, "reference limit exceeded"));
                }
                surface.faces.push(references(&text)?);
                surface.face_visibility.push(!hidden);
                self.faces_seen += 1;
                if hidden {
                    surface.hidden_face_count += 1;
                }
            }
            Capture::SourcePoints {
                text,
                source_path,
                coordinate_dimension,
                ..
            } => {
                let values: Vec<f64> = text
                    .split_ascii_whitespace()
                    .map(|part| part.parse::<f64>().ok())
                    .collect::<Option<_>>()
                    .ok_or_else(|| {
                        error(
                            Code::InvalidSemantic,
                            "source data contains non-numeric coordinate",
                        )
                    })?;
                if !values
                    .len()
                    .is_multiple_of(usize::from(coordinate_dimension))
                    || values.iter().any(|value| !value.is_finite())
                {
                    return Err(error(
                        Code::InvalidSemantic,
                        "source data has an invalid coordinate list",
                    ));
                }
                for coordinates in values.chunks_exact(usize::from(coordinate_dimension)) {
                    let ordinal = surface.source_data_points.len() + 1;
                    surface.source_data_points.push(crate::LandXmlSourcePoint {
                        source_id: LandXmlSourceId(String::new()),
                        ordinal,
                        source_path: source_path.clone(),
                        coordinate_dimension,
                        coordinates: coordinates.to_vec(),
                    });
                }
            }
            Capture::Polyline {
                text,
                category,
                name,
                kind,
                properties,
                source_path,
                coordinate_dimension,
                ..
            } => {
                let values: Vec<f64> = text
                    .split_ascii_whitespace()
                    .map(|part| part.parse::<f64>().ok())
                    .collect::<Option<_>>()
                    .ok_or_else(|| {
                        error(
                            Code::InvalidSemantic,
                            "terrain overlay contains non-numeric coordinate",
                        )
                    })?;
                if values.len() < usize::from(coordinate_dimension) * 2
                    || !values
                        .len()
                        .is_multiple_of(usize::from(coordinate_dimension))
                    || values.iter().any(|value| !value.is_finite())
                {
                    return Err(error(
                        Code::InvalidSemantic,
                        "terrain overlay must contain two or more finite coordinates",
                    ));
                }
                let points = values
                    .chunks_exact(usize::from(coordinate_dimension))
                    .map(|value| value.to_vec())
                    .collect();
                let target = match category {
                    PolylineCategory::Boundary => &mut surface.boundaries,
                    PolylineCategory::Breakline => &mut surface.breaklines,
                    PolylineCategory::Contour => &mut surface.contours,
                };
                target.push(LandXmlPolyline {
                    source_id: LandXmlSourceId(String::new()),
                    ordinal: 0,
                    name,
                    kind,
                    source_path,
                    properties,
                    coordinate_dimension,
                    points,
                    point_source_ids: Vec::new(),
                });
            }
        }
        Ok(())
    }
}
