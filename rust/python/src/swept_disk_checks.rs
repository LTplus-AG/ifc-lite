// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Opt-in Python boundary for source swept-disk geometry checks.

use std::collections::HashSet;

use ifc_lite_processing::{extract_swept_disk_descriptions, SweptDiskCheckOptions};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;

use super::{swept_disks, GEOMETRY_STACK_BYTES};

/// Check authored swept-disk paths without tessellating the model. Each
/// occurrence can contain several source solids, identified in the result by
/// `solid_id`, `directrix_id`, and `mapping_path`. Tolerances describe numerical
/// continuity checks in world metres/radians; they are not fabrication rules.
#[pyfunction]
#[pyo3(signature = (ifc_bytes, ids = None, *, zero_length_tolerance_m = 1e-9, gap_tolerance_m = 1e-6, tangent_tolerance_rad = 1e-6))]
pub(super) fn check_swept_disks(
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

    let descriptions = py
        .detach(|| {
            std::thread::Builder::new()
                .stack_size(GEOMETRY_STACK_BYTES)
                .name("ifclite-swept-disk-checks".into())
                .spawn(move || extract_swept_disk_descriptions(&ifc_bytes, ids.as_ref()))
                .map_err(|error| format!("spawn failed: {error}"))?
                .join()
                .map_err(|_| "swept-disk checker worker panicked".to_string())
        })
        .map_err(PyRuntimeError::new_err)?;
    swept_disks::checks_to_python(py, &descriptions, &options)
}
