// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Python and JSON views of the shared Rust swept-disk description.

use ifc_lite_processing::{check_swept_disk, SweptDiskCheckOptions, SweptDiskDescriptions};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyDict;

pub(super) fn add_to_python(
    py: Python<'_>,
    out: &Bound<'_, PyDict>,
    descriptions: &SweptDiskDescriptions,
) -> PyResult<()> {
    // Decode once through Python's standard JSON parser. The Rust struct is the
    // sole definition of the wire shape, so this stays in sync with the JSON
    // entry point as description variants are added.
    let payload = serde_json::to_string(descriptions)
        .map_err(|e| PyValueError::new_err(e.to_string()))?;
    let decoded = py.import("json")?.getattr("loads")?.call1((payload,))?;
    let encoded_elements = decoded.get_item("elements")?;
    let elements = PyDict::new(py);
    for id in descriptions.elements.keys() {
        elements.set_item(*id, encoded_elements.get_item(id.to_string())?)?;
    }
    out.set_item("swept_disks", elements)?;
    out.set_item("directrix_diagnostics", decoded.get_item("diagnostics")?)?;
    Ok(())
}

pub(super) fn add_to_json(
    json: String,
    descriptions: &SweptDiskDescriptions,
) -> Result<String, serde_json::Error> {
    let mut document: serde_json::Value = serde_json::from_str(&json)?;
    document["swept_disks"] = serde_json::to_value(&descriptions.elements)?;
    document["directrix_diagnostics"] = serde_json::to_value(&descriptions.diagnostics)?;
    serde_json::to_string(&document)
}

/// Check each authored sweep and keep occurrence IDs as Python integer keys.
/// The checker owns the report shape; this boundary only attaches the IFC
/// identity needed to distinguish multiple source solids in one product.
pub(super) fn checks_to_python(
    py: Python<'_>,
    descriptions: &SweptDiskDescriptions,
    options: &SweptDiskCheckOptions,
) -> PyResult<Py<PyAny>> {
    let mut encoded_elements = std::collections::BTreeMap::new();
    for (id, disks) in &descriptions.elements {
        let entries = disks
            .iter()
            .enumerate()
            .map(|(occurrence_index, disk)| {
                let report = check_swept_disk(disk, options)
                    .map_err(|error| PyValueError::new_err(error.to_string()))?;
                Ok(serde_json::json!({
                    "occurrence_index": occurrence_index,
                    "solid_id": disk.solid_id,
                    "directrix_id": disk.directrix_id,
                    "mapping_path": disk.mapping_path,
                    "report": report,
                }))
            })
            .collect::<PyResult<Vec<_>>>()?;
        encoded_elements.insert(*id, entries);
    }
    let payload = serde_json::to_string(&encoded_elements)
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    let decoded = py.import("json")?.getattr("loads")?.call1((payload,))?;
    let elements = PyDict::new(py);
    for id in descriptions.elements.keys() {
        elements.set_item(*id, decoded.get_item(id.to_string())?)?;
    }
    let out = PyDict::new(py);
    out.set_item("elements", elements)?;
    out.set_item("diagnostics", &descriptions.diagnostics)?;
    Ok(out.into_any().unbind())
}
