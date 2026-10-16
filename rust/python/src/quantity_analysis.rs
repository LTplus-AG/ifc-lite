// SPDX-License-Identifier: MPL-2.0
//! Opt-in Python view of provenance-safe authored IFC quantities.

use std::collections::HashSet;
use ifc_lite_export::analyze_authored_quantities;
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::PyDict;
use super::run_geometry;

#[pyfunction]
#[pyo3(signature = (ifc_bytes, ids = None))]
pub(super) fn authored_quantity_analysis(
    py: Python<'_>, ifc_bytes: Vec<u8>, ids: Option<HashSet<u32>>,
) -> PyResult<Py<PyAny>> {
    let view = run_geometry(py, "authored quantity", move || {
        analyze_authored_quantities(&ifc_bytes, ids.as_ref())
    })?;
    let json = serde_json::to_string(&view)
        .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
    let root = py.import("json")?.call_method1("loads", (json,))?;
    let dict = root.cast::<PyDict>()?;
    let products = dict.get_item("products")?.expect("serialized products");
    let numbered = PyDict::new(py);
    for (key, value) in products.cast::<PyDict>()?.iter() {
        let id = key.extract::<String>()?.parse::<u32>()
            .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
        numbered.set_item(id, value)?;
    }
    dict.set_item("products", numbered)?;
    Ok(root.unbind())
}

#[pyfunction]
#[pyo3(signature = (ifc_bytes, ids = None))]
pub(super) fn quantity_analysis(
    py: Python<'_>, ifc_bytes: Vec<u8>, ids: Option<HashSet<u32>>,
) -> PyResult<Py<PyAny>> {
    let view = run_geometry(py, "quantity analysis", move || {
        ifc_lite_export::analyze_quantities(&ifc_bytes, ids.as_ref())
    })?;
    let json = serde_json::to_string(&view)
        .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
    let root = py.import("json")?.call_method1("loads", (json,))?;
    let dict = root.cast::<PyDict>()?;
    let products = dict.get_item("products")?.expect("serialized products");
    let numbered = PyDict::new(py);
    for (key, value) in products.cast::<PyDict>()?.iter() {
        let id = key.extract::<String>()?.parse::<u32>()
            .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
        numbered.set_item(id, value)?;
    }
    dict.set_item("products", numbered)?;
    Ok(root.unbind())
}
