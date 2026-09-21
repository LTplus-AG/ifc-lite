/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

impl Parser<'_> {
    pub(super) fn finish_capture(&mut self) -> Result<()> {
        let capture = self.capture.take().expect("capture checked");
        if self.finish_road_capture(capture)? {
            return Ok(());
        }
        let capture = self.capture.take().expect("non-road capture restored");
        match capture {
            Capture::Point { id, text, .. } => {
                self.reserve_points(1)?;
                let values = triple(&text, "point")?;
                let surface = self
                    .surface
                    .as_mut()
                    .ok_or_else(|| error(Code::InvalidSemantic, "geometry outside Surface"))?;
                if !surface.ids.insert(id.clone()) {
                    return Err(error(Code::InvalidSemantic, "duplicate point id"));
                }
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
                self.reserve_references(3)?;
                let references = references(&text)?;
                let surface = self
                    .surface
                    .as_mut()
                    .ok_or_else(|| error(Code::InvalidSemantic, "geometry outside Surface"))?;
                surface.faces.push(references);
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
                let coordinate_count = text.split_ascii_whitespace().count();
                if coordinate_count % usize::from(coordinate_dimension) != 0 {
                    return Err(error(
                        Code::InvalidSemantic,
                        "source data has an invalid coordinate list",
                    ));
                }
                let point_count = coordinate_count / usize::from(coordinate_dimension);
                self.reserve_points(point_count)?;
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
                if values.iter().any(|value| !value.is_finite()) {
                    return Err(error(
                        Code::InvalidSemantic,
                        "source data has an invalid coordinate list",
                    ));
                }
                let surface = self
                    .surface
                    .as_mut()
                    .ok_or_else(|| error(Code::InvalidSemantic, "geometry outside Surface"))?;
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
                self.points_seen += point_count;
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
                let coordinate_count = text.split_ascii_whitespace().count();
                if coordinate_count < usize::from(coordinate_dimension) * 2
                    || coordinate_count % usize::from(coordinate_dimension) != 0
                {
                    return Err(error(
                        Code::InvalidSemantic,
                        "terrain overlay must contain two or more finite coordinates",
                    ));
                }
                let point_count = coordinate_count / usize::from(coordinate_dimension);
                self.reserve_points(point_count)?;
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
                if values.iter().any(|value| !value.is_finite()) {
                    return Err(error(
                        Code::InvalidSemantic,
                        "terrain overlay must contain two or more finite coordinates",
                    ));
                }
                let points = values
                    .chunks_exact(usize::from(coordinate_dimension))
                    .map(|value| value.to_vec())
                    .collect();
                let surface = self
                    .surface
                    .as_mut()
                    .ok_or_else(|| error(Code::InvalidSemantic, "geometry outside Surface"))?;
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
                self.points_seen += point_count;
            }
            Capture::ProfilePoint { .. }
            | Capture::PairList { .. }
            | Capture::CrossSectionPoint { .. } => {
                return Err(error(
                    Code::InvalidSemantic,
                    "profile/section capture was not finalized",
                ));
            }
        }
        Ok(())
    }
}
