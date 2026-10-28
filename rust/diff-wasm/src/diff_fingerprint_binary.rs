// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Explicit batch input: sparse cardinality and scalar tokens are lossless.
use ifc_lite_diff::{DocumentValue as Value, JsString, document_serde,
    input::{DataFingerprintInput, PropertyEntryInput, PropertySetInput, QuantitySetInput, TypeAssignmentInput},
    sparse_collection::SparseCollection,
    fingerprint::build_fingerprint_pair_checked};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct Slots<T> { present: Vec<T>, holes: usize }
impl<T> Slots<T> {
    fn into_sparse(self) -> SparseCollection<T> {
        let mut result = SparseCollection::from(self.present);
        result.push_holes(self.holes); result
    }
}
#[derive(Deserialize)]
struct Set { name: JsString, members: Slots<PropertyEntryInput> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    ifc_type: JsString, name: Option<JsString>, description: Option<JsString>,
    object_type: Option<JsString>, predefined_type: Option<JsString>, tag: Option<JsString>,
    property_sets: Slots<Set>, quantity_sets: Slots<Set>, type_assignments: Slots<TypeAssignmentInput>,
    materials: Vec<JsString>, classifications: Vec<JsString>,
}
impl Input {
    fn into_input(self) -> DataFingerprintInput {
        DataFingerprintInput {
            ifc_type: self.ifc_type, name: self.name, description: self.description,
            object_type: self.object_type, predefined_type: self.predefined_type, tag: self.tag,
            property_sets: self.property_sets.into_sparse().map(|set| PropertySetInput {
                name: set.name, properties: set.members.into_sparse(),
            }),
            quantity_sets: self.quantity_sets.into_sparse().map(|set| QuantitySetInput {
                name: set.name, quantities: set.members.into_sparse(),
            }),
            type_assignments: self.type_assignments.into_sparse(), materials: self.materials,
            classifications: self.classifications,
        }
    }
}
fn fits(length: u64) -> Result<(), JsValue> {
    super::diff_fingerprint_host::string_fits(length as f64)
}
/// One decode per entity, both fingerprints from the same owned native input.
pub(crate) fn build(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    let document = crate::diff_binary::decode(bytes).map_err(|e| JsValue::from_str(&e))?;
    let inputs: Vec<Input> = document_serde::from_document(document)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mut results = Vec::new();
    for input in inputs {
        let input = input.into_input();
        let (data, components) = build_fingerprint_pair_checked(&input, fits)?;
        results.push(Value::Object(vec![
            ("dataHash".into(), Value::String(data.into())),
            ("components".into(), Value::Object(components.into_iter()
                .map(|(key, value)| (key, Value::String(value.into()))).collect())),
        ]));
    }
    Ok(crate::diff_binary::encode(&Value::Array(results)))
}
