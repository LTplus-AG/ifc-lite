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
            Capture::Face { text, hidden, .. } if !hidden => {
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
                self.faces_seen += 1;
            }
            Capture::Face { .. } => surface.hidden_face_count += 1,
            Capture::Polyline {
                text,
                category,
                name,
                kind,
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
                if values.len() < 6
                    || !values.len().is_multiple_of(3)
                    || values.iter().any(|value| !value.is_finite())
                {
                    return Err(error(
                        Code::InvalidSemantic,
                        "terrain overlay must contain two or more finite 3D coordinates",
                    ));
                }
                let points = values
                    .chunks_exact(3)
                    .map(|value| [value[0], value[1], value[2]])
                    .collect();
                let target = match category {
                    PolylineCategory::Boundary => &mut surface.boundaries,
                    PolylineCategory::Breakline => &mut surface.breaklines,
                    PolylineCategory::Contour => &mut surface.contours,
                };
                target.push(LandXmlPolyline {
                    source_id: LandXmlSourceId(String::new()),
                    name,
                    kind,
                    points,
                });
            }
        }
        Ok(())
    }
}
