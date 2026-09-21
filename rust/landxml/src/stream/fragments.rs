/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Move-owned, bounded component packaging for one completed terrain record.

use serde::Serialize;

use super::{
    LandXmlStreamEvent, LandXmlSurfaceComponent, LandXmlSurfaceFragment,
    MAX_LANDXML_STREAM_QUEUED_BYTES,
};
use crate::{xml::error, LandXmlDiagnosticCode as Code, LandXmlError, LandXmlSurface};

/// A `Vec<u8>` is JSON-encoded as decimal bytes, so keep payloads well below
/// the event reservation even for values whose every byte needs four chars.
pub(super) const MAX_FRAGMENT_PAYLOAD_BYTES: usize = 32 * 1024;

#[derive(Serialize)]
struct SurfaceStart {
    ordinal: usize,
    source_path: String,
    properties: crate::LandXmlProperties,
    definition_properties: crate::LandXmlProperties,
    name: String,
    kind: crate::LandXmlSurfaceKind,
    render_state: crate::LandXmlRenderState,
    topology_origin: crate::LandXmlTopologyOrigin,
    terrain_diagnostic: Option<crate::LandXmlTerrainDiagnostic>,
    hidden_face_count: usize,
}

#[derive(Serialize)]
struct Face {
    ids: [String; 3],
    source_id: crate::LandXmlSourceId,
    visible: bool,
}

struct Payload {
    component: LandXmlSurfaceComponent,
    bytes: Vec<u8>,
    offset: usize,
    sequence: usize,
}

#[derive(Clone, Copy)]
enum Stage {
    Start,
    Points,
    CanonicalVertices,
    SourceDataPoints,
    Faces,
    Boundaries,
    Breaklines,
    Contours,
    End,
    Complete,
}

/// Owns exactly one finalized surface and yields one transport record at a
/// time. Faces are zipped from their original vectors rather than collected
/// into a second complete allocation for JSON serialization.
pub(super) struct SurfaceCursor {
    source_id: String,
    start: Option<SurfaceStart>,
    points: std::vec::IntoIter<crate::LandXmlPoint>,
    canonical_vertices: std::vec::IntoIter<crate::LandXmlCanonicalVertex>,
    source_data_points: std::vec::IntoIter<crate::LandXmlSourcePoint>,
    faces: std::vec::IntoIter<[String; 3]>,
    face_source_ids: std::vec::IntoIter<crate::LandXmlSourceId>,
    face_visibility: std::vec::IntoIter<bool>,
    boundaries: std::vec::IntoIter<crate::LandXmlPolyline>,
    breaklines: std::vec::IntoIter<crate::LandXmlPolyline>,
    contours: std::vec::IntoIter<crate::LandXmlPolyline>,
    stage: Stage,
    payload: Option<Payload>,
}

impl SurfaceCursor {
    pub(super) fn new(surface: LandXmlSurface) -> Self {
        let LandXmlSurface {
            source_id,
            ordinal,
            source_path,
            properties,
            definition_properties,
            name,
            kind,
            render_state,
            topology_origin,
            terrain_diagnostic,
            points,
            canonical_vertices,
            source_data_points,
            faces,
            face_source_ids,
            face_visibility,
            hidden_face_count,
            boundaries,
            breaklines,
            contours,
        } = surface;
        Self {
            source_id: source_id.0,
            start: Some(SurfaceStart {
                ordinal,
                source_path,
                properties,
                definition_properties,
                name,
                kind,
                render_state,
                topology_origin,
                terrain_diagnostic,
                hidden_face_count,
            }),
            points: points.into_iter(),
            canonical_vertices: canonical_vertices.into_iter(),
            source_data_points: source_data_points.into_iter(),
            faces: faces.into_iter(),
            face_source_ids: face_source_ids.into_iter(),
            face_visibility: face_visibility.into_iter(),
            boundaries: boundaries.into_iter(),
            breaklines: breaklines.into_iter(),
            contours: contours.into_iter(),
            stage: Stage::Start,
            payload: None,
        }
    }

    pub(super) fn next_event(&mut self) -> Result<Option<LandXmlStreamEvent>, LandXmlError> {
        loop {
            if let Some(payload) = &mut self.payload {
                let end = (payload.offset + MAX_FRAGMENT_PAYLOAD_BYTES).min(payload.bytes.len());
                let event = LandXmlStreamEvent::Surface(LandXmlSurfaceFragment {
                    source_id: self.source_id.clone(),
                    component: payload.component,
                    sequence: payload.sequence,
                    continued: end < payload.bytes.len(),
                    payload_utf8: payload.bytes[payload.offset..end].to_vec(),
                });
                payload.offset = end;
                payload.sequence += 1;
                if payload.offset == payload.bytes.len() {
                    self.payload = None;
                }
                return Ok(Some(event));
            }
            let Some((component, bytes)) = self.next_value()? else {
                return Ok(None);
            };
            self.payload = Some(Payload {
                component,
                bytes,
                offset: 0,
                sequence: 0,
            });
        }
    }

    fn next_value(&mut self) -> Result<Option<(LandXmlSurfaceComponent, Vec<u8>)>, LandXmlError> {
        loop {
            match self.stage {
                Stage::Start => {
                    self.stage = Stage::Points;
                    return Ok(Some((
                        LandXmlSurfaceComponent::Start,
                        serialize(&self.start.take().expect("start emitted once"))?,
                    )));
                }
                Stage::Points => match self.points.next() {
                    Some(value) => return value_for(LandXmlSurfaceComponent::Points, value),
                    None => self.stage = Stage::CanonicalVertices,
                },
                Stage::CanonicalVertices => match self.canonical_vertices.next() {
                    Some(value) => {
                        return value_for(LandXmlSurfaceComponent::CanonicalVertices, value);
                    }
                    None => self.stage = Stage::SourceDataPoints,
                },
                Stage::SourceDataPoints => match self.source_data_points.next() {
                    Some(value) => {
                        return value_for(LandXmlSurfaceComponent::SourceDataPoints, value);
                    }
                    None => self.stage = Stage::Faces,
                },
                Stage::Faces => {
                    let face = match (
                        self.faces.next(),
                        self.face_source_ids.next(),
                        self.face_visibility.next(),
                    ) {
                        (Some(ids), Some(source_id), Some(visible)) => Face {
                            ids,
                            source_id,
                            visible,
                        },
                        (None, None, None) => {
                            self.stage = Stage::Boundaries;
                            continue;
                        }
                        _ => {
                            return Err(error(
                                Code::InvalidSemantic,
                                "surface face identity vectors are inconsistent",
                            ));
                        }
                    };
                    return value_for(LandXmlSurfaceComponent::Faces, face);
                }
                Stage::Boundaries => match self.boundaries.next() {
                    Some(value) => return value_for(LandXmlSurfaceComponent::Boundaries, value),
                    None => self.stage = Stage::Breaklines,
                },
                Stage::Breaklines => match self.breaklines.next() {
                    Some(value) => return value_for(LandXmlSurfaceComponent::Breaklines, value),
                    None => self.stage = Stage::Contours,
                },
                Stage::Contours => match self.contours.next() {
                    Some(value) => return value_for(LandXmlSurfaceComponent::Contours, value),
                    None => self.stage = Stage::End,
                },
                Stage::End => {
                    self.stage = Stage::Complete;
                    return Ok(Some((LandXmlSurfaceComponent::End, Vec::new())));
                }
                Stage::Complete => return Ok(None),
            }
        }
    }
}

fn value_for<T: Serialize>(
    component: LandXmlSurfaceComponent,
    value: T,
) -> Result<Option<(LandXmlSurfaceComponent, Vec<u8>)>, LandXmlError> {
    Ok(Some((component, serialize(&value)?)))
}

fn serialize<T: Serialize>(value: &T) -> Result<Vec<u8>, LandXmlError> {
    let bytes = serde_json::to_vec(value).map_err(|value| {
        error(
            Code::InvalidSemantic,
            format!("stream serialization failed: {value}"),
        )
    })?;
    if bytes.len() > MAX_LANDXML_STREAM_QUEUED_BYTES {
        return Err(error(
            Code::LimitExceeded,
            "surface component exceeds the 512 KiB credited serialization limit",
        ));
    }
    Ok(bytes)
}
