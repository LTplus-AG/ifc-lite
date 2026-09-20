// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::{HashMap, HashSet};

use crate::{LandXmlPipeFlow, LandXmlPipeUnits, LandXmlSourceId};

use super::super::{convert, state::FlowInput, PipeParser};

pub(super) fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

pub(super) fn duplicate_names<'a>(names: impl Iterator<Item = &'a str>) -> HashSet<String> {
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();
    for name in names {
        if !seen.insert(name) {
            duplicates.insert(name.to_owned());
        }
    }
    duplicates
}

pub(super) fn unique_names<'a>(
    items: impl Iterator<Item = (&'a String, &'a LandXmlSourceId)>,
) -> HashMap<String, LandXmlSourceId> {
    items
        .map(|(name, source_id)| (name.clone(), source_id.clone()))
        .collect()
}

pub(super) fn required_reference(
    reference: Option<String>,
    label: &str,
    target: &str,
    values: &HashMap<String, LandXmlSourceId>,
) -> std::result::Result<LandXmlSourceId, String> {
    let reference = non_empty(reference).ok_or_else(|| format!("Pipe is missing {label}"))?;
    values
        .get(&reference)
        .cloned()
        .ok_or_else(|| format!("{label} references unknown or refused {target} {reference}"))
}

pub(super) fn convert_flow(
    parser: &mut PipeParser<'_>,
    input: FlowInput,
    units: &LandXmlPipeUnits,
) -> crate::xml::Result<Option<LandXmlPipeFlow>> {
    let source_id = input.source_id.clone();
    let source_path = input.source_path.clone();
    match convert::flow(input, units) {
        Ok(flow) => Ok(Some(flow)),
        Err(message) => {
            parser.refuse(source_id, source_path, &message)?;
            Ok(None)
        }
    }
}
