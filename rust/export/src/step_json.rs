// SPDX-License-Identifier: MPL-2.0
//! The mutation-JSON bridge: the wasm-facing entry point to the STEP writer.
//!
//! Its own module because it is its own contract. `step.rs` writes a model that
//! is already in hand; this is the boundary a caller on the other side of the
//! wasm ABI crosses, so it owns the payload shape, the rename attributes that
//! spell it, and the fail-closed rule for a payload that does not parse.

use serde::Deserialize;

use crate::step::{export_step, AttrMutation, PropMutation, StepOptions};
use crate::step_log::{export_step_with_log, MutationLog};


#[derive(Deserialize)]
struct AttrMutJson {
    #[serde(rename = "expressId")]
    express_id: u32,
    index: usize,
    value: String,
}

#[derive(Deserialize)]
struct PropMutJson {
    #[serde(rename = "expressId")]
    express_id: u32,
    #[serde(rename = "psetName")]
    pset_name: String,
    #[serde(rename = "propName")]
    prop_name: String,
    value: String,
}

#[derive(Deserialize, Default)]
struct MutationsJson {
    #[serde(default, rename = "attributeUpdates")]
    attribute_updates: Vec<AttrMutJson>,
    #[serde(default, rename = "propertyMutations")]
    property_mutations: Vec<PropMutJson>,
}

/// Export STEP from raw bytes + a JSON mutation payload (the wasm bridge form of a
/// `MutablePropertyView` diff).
///
/// Two payload shapes are accepted. A payload with a `mutations` array is the
/// mutation LOG `MutablePropertyView.exportMutations()` writes (optionally with
/// `newEntities` / `georefMutations`, see [`crate::MutationLog`]) and goes
/// through [`crate::export_step_with_log`], the writer that applies the whole
/// mutation vocabulary with byte parity to the TypeScript `StepExporter`
/// (#5941). Any other object is the older pre-serialized shape below. A payload
/// carrying both is refused: which set of edits it meant is not recoverable.
///
/// The older `mutations_json` shape:
/// `{ "attributeUpdates": [{expressId,index,value}], "propertyMutations":
/// [{expressId,psetName,propName,value}] }` where `value` is already STEP-serialized
/// (`'Name'`, `IFCLABEL('x')`, `IFCREAL(1.)`). An empty string means "no mutations" —
/// a legitimate, common case (plain re-export). A non-empty string that fails to
/// parse is a caller bug (a malformed payload, a version mismatch across the wasm
/// boundary) and must not be treated the same way: silently falling back to "no
/// mutations" would export a file that LOOKS like a successful re-export of the
/// user's edits but silently contains none of them. Callers get an `Err` instead,
/// matching `exportGlb`'s and `exportMerged`'s fail-closed contract at this same
/// wasm boundary.
pub fn export_step_json(
    content: &[u8],
    schema: Option<String>,
    included: Option<Vec<u32>>,
    mutations_json: &str,
) -> Result<String, String> {
    if !mutations_json.trim().is_empty() {
        let value: serde_json::Value =
            serde_json::from_str(mutations_json).map_err(|e| format!("invalid mutations_json: {e}"))?;
        if value.get("mutations").is_some() {
            if value.get("attributeUpdates").is_some() || value.get("propertyMutations").is_some() {
                return Err("invalid mutations_json: a mutation log (`mutations`) cannot be combined with \
                            `attributeUpdates` / `propertyMutations`"
                    .to_string());
            }
            let log: MutationLog =
                serde_json::from_value(value).map_err(|e| format!("invalid mutations_json: {e}"))?;
            let opts = StepOptions { schema, included, ..StepOptions::default() };
            return export_step_with_log(content, &opts, &log).map(|(s, _)| s).map_err(|e| e.to_string());
        }
    }
    let muts: MutationsJson = if mutations_json.trim().is_empty() {
        MutationsJson::default()
    } else {
        serde_json::from_str(mutations_json)
            .map_err(|e| format!("invalid mutations_json: {e}"))?
    };
    let opts = StepOptions {
        schema,
        included,
        attribute_mutations: muts
            .attribute_updates
            .into_iter()
            .map(|a| AttrMutation { express_id: a.express_id, index: a.index, value: a.value })
            .collect(),
        property_mutations: muts
            .property_mutations
            .into_iter()
            .map(|p| PropMutation {
                express_id: p.express_id,
                pset_name: p.pset_name,
                prop_name: p.prop_name,
                value: p.value,
            })
            .collect(),
        ..StepOptions::default()
    };
    export_step(content, &opts).map_err(|e| e.to_string())
}
