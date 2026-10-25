// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::DocumentValue as Value;
use crate::{engine::DiffOptions, model::{KeyDiffOptions,DiffScope}, geometry_compare::GeometryTolerances,
    split_types::SplitSettings, successor::SuccessorSettings};
pub fn options_from_document(value: &Value) -> DiffOptions {
    DiffOptions {
        key: KeyDiffOptions {
            scope: match value["scope"].as_str() {Some("data")=>DiffScope::Data,Some("geometry")=>DiffScope::Geometry,_=>DiffScope::Both},
            exclude_types: value["excludeTypes"].as_array().into_iter().flatten().filter_map(Value::as_string).cloned().collect(),
            key_aliases: value["keyAliases"].as_array().map(|a|a.iter().filter_map(|p|Some((p[0].as_string()?.clone(),p[1].as_string()?.clone()))).collect()),
        },
        geometry: GeometryTolerances::resolve(value["moveTolerance"].as_f64(),value["reshapeTolerance"].as_f64(),value["maxMoveDistance"].as_f64()),
        match_unpaired_by_content:value["matchUnpairedByContent"]==true,
        detect_split_merge:value["detectSplitMerge"]==true,detect_successors:value["detectSuccessors"]==true,
        split:SplitSettings::resolve(value["splitVolumeTolerance"].as_f64(),value["splitPaddingMin"].as_f64(),value["splitPaddingRatio"].as_f64(),value["maxSplitPieces"].as_f64()),
        successor:SuccessorSettings::resolve(value["successorOverlap"].as_f64(),value["successorDistance"].as_f64()),
        class_families:value["classFamilies"].as_array().map(|a|a.iter().filter_map(Value::as_array).map(|r|r.iter().filter_map(Value::as_string).cloned().collect()).collect()),
    }
}

/// Convenience for scalar native JSON callers; JS uses the lossless document.
pub fn options_from_json(value: &serde_json::Value) -> DiffOptions {
    options_from_document(&Value::from(value))
}
