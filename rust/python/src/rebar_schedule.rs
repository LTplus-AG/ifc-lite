// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Python view of the shared Rust reinforcing-bar schedule.

use std::collections::HashSet;

use ifc_lite_export::build_rebar_schedule;
use ifc_lite_processing::SweptDiskCheckOptions;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;

use super::GEOMETRY_STACK_BYTES;

/// Return authored rebar metadata and geometric source-sweep measurements.
/// Values are not certified cutting lengths or physical bar counts.
#[pyfunction]
#[pyo3(signature = (ifc_bytes, ids = None, *, zero_length_tolerance_m = 1e-9, gap_tolerance_m = 1e-6, tangent_tolerance_rad = 1e-6))]
pub(super) fn rebar_schedule(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    ids: Option<HashSet<u32>>,
    zero_length_tolerance_m: f64,
    gap_tolerance_m: f64,
    tangent_tolerance_rad: f64,
) -> PyResult<Py<PyAny>> {
    let mut options = SweptDiskCheckOptions::default();
    options.zero_length_tolerance_m = zero_length_tolerance_m;
    options.gap_tolerance_m = gap_tolerance_m;
    options.tangent_tolerance_rad = tangent_tolerance_rad;
    options
        .validate()
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    let schedule = py
        .detach(|| {
            std::thread::Builder::new()
                .stack_size(GEOMETRY_STACK_BYTES)
                .name("ifclite-rebar-schedule".into())
                .spawn(move || build_rebar_schedule(&ifc_bytes, ids.as_ref(), &options))
                .map_err(|error| format!("spawn failed: {error}"))?
                .join()
                .map_err(|_| "rebar schedule worker panicked".to_string())?
                .map_err(|error| error.to_string())
        })
        .map_err(PyRuntimeError::new_err)?;
    let payload = serde_json::to_string(&schedule)
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    let decoded = py.import("json")?.getattr("loads")?.call1((payload,))?;
    let rows = decoded.get_item("rows")?;
    let keyed = PyDict::new(py);
    for id in schedule.rows.keys() {
        keyed.set_item(*id, rows.get_item(id.to_string())?)?;
    }
    decoded.set_item("rows", keyed)?;
    Ok(decoded.unbind())
}
