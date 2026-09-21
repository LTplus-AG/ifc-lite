/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Profile and roadway reference resolution diagnostics.

use std::collections::HashMap;

use crate::{LandXmlCapabilityDiagnostic, LandXmlCapabilityDiagnosticCode, LandXmlSourceId};

pub(super) enum ReferenceResolution {
    Missing,
    Ambiguous,
}

pub(super) fn unique_reference(
    source_ids: &HashMap<String, Vec<LandXmlSourceId>>,
    reference: &str,
) -> std::result::Result<LandXmlSourceId, ReferenceResolution> {
    match source_ids.get(reference).map(Vec::as_slice) {
        Some([source_id]) => Ok(source_id.clone()),
        Some(_) => Err(ReferenceResolution::Ambiguous),
        None => Err(ReferenceResolution::Missing),
    }
}

pub(super) fn missing_reference(
    source_id: &LandXmlSourceId,
    source_path: &str,
    source_kind: &str,
    reference_kind: &str,
    reference: &str,
) -> LandXmlCapabilityDiagnostic {
    LandXmlCapabilityDiagnostic {
        code: LandXmlCapabilityDiagnosticCode::MissingReference,
        source_id: Some(source_id.clone()),
        source_path: source_path.to_owned(),
        message: format!("{source_kind} references unknown {reference_kind} \"{reference}\""),
    }
}

pub(super) fn ambiguous_reference(
    source_id: &LandXmlSourceId,
    source_path: &str,
    source_kind: &str,
    reference_kind: &str,
    reference: &str,
) -> LandXmlCapabilityDiagnostic {
    LandXmlCapabilityDiagnostic {
        code: LandXmlCapabilityDiagnosticCode::AmbiguousReference,
        source_id: Some(source_id.clone()),
        source_path: source_path.to_owned(),
        message: format!("{source_kind} references ambiguous {reference_kind} \"{reference}\""),
    }
}
