// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_geometry::{sample_alignment_axes, AlignmentSamplingOptions};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyDict;

use super::run_geometry;

/// Sample alignment identity and frames through the shared Rust evaluator.
///
/// Runs like every other entry point: GIL released, on the large-stack
/// geometry pool, with a panic surfaced as `RuntimeError` (EDGE-FFI-12, #7694).
#[pyfunction]
#[pyo3(signature = (ifc_bytes, *, spacing_m=1.0, max_samples_per_axis=5001, max_total_samples=100000))]
pub(super) fn alignment_axes(
    py: Python<'_>,
    ifc_bytes: &[u8],
    spacing_m: f64,
    max_samples_per_axis: usize,
    max_total_samples: usize,
) -> PyResult<Py<PyAny>> {
    let options = AlignmentSamplingOptions {
        spacing_m,
        max_samples_per_axis,
        max_total_samples,
    };
    let report = run_geometry(py, "alignment sampling", || sample_alignment_axes(ifc_bytes, options))?
        .map_err(|e| PyValueError::new_err(e.to_string()))?;
    let payload = crate::finite_json::to_json_string(&report)?;
    let decoded = py.import("json")?.getattr("loads")?.call1((payload,))?;
    let axes = PyDict::new(py);
    for (index, axis) in report.axes.iter().enumerate() {
        axes.set_item(axis.express_id, decoded.get_item("axes")?.get_item(index)?)?;
    }
    let out = PyDict::new(py);
    out.set_item("axes", axes)?;
    out.set_item("diagnostics", decoded.get_item("diagnostics")?)?;
    out.set_item("diagnostics_omitted", report.diagnostics_omitted)?;
    Ok(out.into_any().unbind())
}
