/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded JSON component packaging for completed terrain records.

use std::collections::VecDeque;

use serde::Serialize;

use super::{LandXmlStreamEvent, LandXmlSurfaceComponent, LandXmlSurfaceFragment};
use crate::{xml::error, LandXmlDiagnosticCode as Code, LandXmlError, LandXmlSurface};

pub(super) const MAX_FRAGMENT_PAYLOAD_BYTES: usize = 192 * 1024;

pub(super) fn push_value<T: Serialize>(
    queue: &mut VecDeque<LandXmlStreamEvent>,
    source_id: &str,
    component: LandXmlSurfaceComponent,
    value: &T,
) -> Result<(), LandXmlError> {
    let bytes = serde_json::to_vec(value).map_err(|value| {
        error(
            Code::InvalidSemantic,
            format!("stream serialization failed: {value}"),
        )
    })?;
    for (sequence, payload_utf8) in bytes.chunks(MAX_FRAGMENT_PAYLOAD_BYTES).enumerate() {
        queue.push_back(LandXmlStreamEvent::Surface(LandXmlSurfaceFragment {
            source_id: source_id.to_owned(),
            component,
            sequence,
            continued: (sequence + 1) * MAX_FRAGMENT_PAYLOAD_BYTES < bytes.len(),
            payload_utf8: payload_utf8.to_vec(),
        }));
    }
    Ok(())
}

pub(super) fn push_values<T: Serialize>(
    queue: &mut VecDeque<LandXmlStreamEvent>,
    source_id: &str,
    component: LandXmlSurfaceComponent,
    values: Vec<T>,
) -> Result<(), LandXmlError> {
    for value in values {
        push_value(queue, source_id, component, &value)?;
    }
    Ok(())
}

pub(super) fn enqueue_surface(
    queue: &mut VecDeque<LandXmlStreamEvent>,
    surface: LandXmlSurface,
) -> Result<(), LandXmlError> {
    let source_id = surface.source_id.0.clone();
    #[derive(Serialize)]
    struct Start<'a> {
        ordinal: usize,
        source_path: &'a str,
        properties: &'a crate::LandXmlProperties,
        definition_properties: &'a crate::LandXmlProperties,
        name: &'a str,
        kind: crate::LandXmlSurfaceKind,
        render_state: crate::LandXmlRenderState,
        topology_origin: crate::LandXmlTopologyOrigin,
        terrain_diagnostic: &'a Option<crate::LandXmlTerrainDiagnostic>,
        hidden_face_count: usize,
    }
    push_value(
        queue,
        &source_id,
        LandXmlSurfaceComponent::Start,
        &Start {
            ordinal: surface.ordinal,
            source_path: &surface.source_path,
            properties: &surface.properties,
            definition_properties: &surface.definition_properties,
            name: &surface.name,
            kind: surface.kind,
            render_state: surface.render_state,
            topology_origin: surface.topology_origin,
            terrain_diagnostic: &surface.terrain_diagnostic,
            hidden_face_count: surface.hidden_face_count,
        },
    )?;
    push_values(
        queue,
        &source_id,
        LandXmlSurfaceComponent::Points,
        surface.points,
    )?;
    push_values(
        queue,
        &source_id,
        LandXmlSurfaceComponent::CanonicalVertices,
        surface.canonical_vertices,
    )?;
    push_values(
        queue,
        &source_id,
        LandXmlSurfaceComponent::SourceDataPoints,
        surface.source_data_points,
    )?;
    #[derive(Serialize)]
    struct Face {
        ids: [String; 3],
        source_id: crate::LandXmlSourceId,
        visible: bool,
    }
    let faces = surface
        .faces
        .into_iter()
        .enumerate()
        .map(|(index, ids)| Face {
            ids,
            source_id: surface.face_source_ids[index].clone(),
            visible: surface.face_visibility[index],
        })
        .collect::<Vec<_>>();
    push_values(queue, &source_id, LandXmlSurfaceComponent::Faces, faces)?;
    push_values(
        queue,
        &source_id,
        LandXmlSurfaceComponent::Boundaries,
        surface.boundaries,
    )?;
    push_values(
        queue,
        &source_id,
        LandXmlSurfaceComponent::Breaklines,
        surface.breaklines,
    )?;
    push_values(
        queue,
        &source_id,
        LandXmlSurfaceComponent::Contours,
        surface.contours,
    )?;
    queue.push_back(LandXmlStreamEvent::Surface(LandXmlSurfaceFragment {
        source_id,
        component: LandXmlSurfaceComponent::End,
        sequence: 0,
        continued: false,
        payload_utf8: Vec::new(),
    }));
    Ok(())
}
