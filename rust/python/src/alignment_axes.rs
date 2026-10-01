// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_geometry::{sample_alignment_axes, AlignmentSamplingOptions};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyDict;

/// Sample alignment identity and frames through the shared Rust evaluator.
#[pyfunction]
#[pyo3(signature = (ifc_bytes, *, spacing_m=1.0, max_samples_per_axis=5001, max_total_samples=100000))]
pub(super) fn alignment_axes(
    py: Python<'_>,
    ifc_bytes: &[u8],
    spacing_m: f64,
    max_samples_per_axis: usize,
    max_total_samples: usize,
) -> PyResult<Py<PyAny>> {
    let content = std::str::from_utf8(ifc_bytes)
        .map_err(|e| PyValueError::new_err(format!("IFC STEP must be UTF-8: {e}")))?;
    let options = AlignmentSamplingOptions {
        spacing_m,
        max_samples_per_axis,
        max_total_samples,
    };
    let report = py
        .detach(|| sample_alignment_axes(content, options))
        .map_err(|e| PyValueError::new_err(e.to_string()))?;
    let payload =
        serde_json::to_string(&report).map_err(|e| PyValueError::new_err(e.to_string()))?;
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
