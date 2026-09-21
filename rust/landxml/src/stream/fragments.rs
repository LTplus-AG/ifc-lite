/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded JSON component packaging for completed terrain records.

use std::collections::VecDeque;

use serde::Serialize;

use super::{LandXmlStreamEvent, LandXmlSurfaceComponent, LandXmlSurfaceFragment};
use crate::{xml::error, LandXmlDiagnosticCode as Code, LandXmlError};

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
