/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Credited transport queueing for completed terrain surfaces.

use super::{
    fragments, LandXmlStreamEvent, LandXmlTinStreamSession, QueuedEvent,
    MAX_LANDXML_STREAM_EVENT_BYTES, MAX_LANDXML_STREAM_QUEUED_BYTES,
    MAX_LANDXML_STREAM_QUEUED_EVENTS,
};
use crate::{xml::error, LandXmlDiagnosticCode as Code, LandXmlError, LandXmlSurface};

impl LandXmlTinStreamSession {
    pub(super) fn emit_header_and_surfaces(&mut self) -> Result<(), LandXmlError> {
        if !self.header_emitted {
            if let Some(header) = self.header() {
                // A numeric surface cannot leave the parser without Units;
                // wait for them so the transport header remains the complete
                // geometry contract. Unit-less preserved-only documents get
                // their one header during `finish_cursor` instead.
                if header.units.is_some() {
                    self.push_event(LandXmlStreamEvent::Header(header))?;
                    self.header_emitted = true;
                }
            }
        }
        for surface in self.parser().take_surfaces() {
            let units = self.header().and_then(|header| header.units);
            crate::parser::require_units_for_renderable_tin(
                crate::parser::surface_draws_to_scale(&surface),
                units.as_ref(),
            )?;
            self.enqueue_surface(surface)?;
        }
        self.flush_pending_surface()
    }

    fn enqueue_surface(&mut self, surface: LandXmlSurface) -> Result<(), LandXmlError> {
        self.surfaces_drained += 1;
        if surface.render_state == crate::LandXmlRenderState::Rendered {
            self.renderable_surfaces += 1;
        } else {
            self.preserved_surfaces += 1;
        }
        if self.pending_surface.is_some() {
            return Err(error(
                Code::InvalidSemantic,
                "a completed surface was received before prior output drained",
            ));
        }
        self.pending_surface = Some(fragments::SurfaceCursor::new(surface));
        Ok(())
    }

    pub(super) fn flush_pending_surface(&mut self) -> Result<(), LandXmlError> {
        loop {
            if self.queue.len() == MAX_LANDXML_STREAM_QUEUED_EVENTS {
                return Ok(());
            }
            if self.queued_bytes > MAX_LANDXML_STREAM_QUEUED_BYTES - MAX_LANDXML_STREAM_EVENT_BYTES
            {
                return Ok(());
            }
            let Some(cursor) = &mut self.pending_surface else {
                return Ok(());
            };
            let Some(event) = cursor.next_event()? else {
                self.pending_surface = None;
                continue;
            };
            self.push_event(event)?;
        }
    }

    pub(super) fn flush_pending_metadata(&mut self) -> Result<(), LandXmlError> {
        loop {
            if self.queue.len() == MAX_LANDXML_STREAM_QUEUED_EVENTS {
                return Ok(());
            }
            if self.queued_bytes > MAX_LANDXML_STREAM_QUEUED_BYTES - MAX_LANDXML_STREAM_EVENT_BYTES
            {
                return Ok(());
            }
            let Some(cursor) = &mut self.metadata_cursor else {
                return Ok(());
            };
            let Some(event) = cursor.next_event()? else {
                self.metadata_cursor = None;
                return Ok(());
            };
            self.push_event(LandXmlStreamEvent::Metadata(Box::new(event)))?;
        }
    }

    pub(super) fn push_event(&mut self, event: LandXmlStreamEvent) -> Result<(), LandXmlError> {
        let serialized_bytes = serde_json::to_vec(&event)
            .map_err(|value| {
                error(
                    Code::InvalidSemantic,
                    format!("stream serialization failed: {value}"),
                )
            })?
            .len();
        if serialized_bytes > MAX_LANDXML_STREAM_EVENT_BYTES {
            return Err(error(
                Code::LimitExceeded,
                "stream event exceeds bounded event limit",
            ));
        }
        if self.queue.len() == MAX_LANDXML_STREAM_QUEUED_EVENTS
            || self.queued_bytes + serialized_bytes > MAX_LANDXML_STREAM_QUEUED_BYTES
        {
            return Err(error(
                Code::LimitExceeded,
                "stream event exceeded reserved output credit",
            ));
        }
        self.queued_bytes += serialized_bytes;
        self.queue.push_back(QueuedEvent {
            event,
            serialized_bytes,
        });
        Ok(())
    }
}
