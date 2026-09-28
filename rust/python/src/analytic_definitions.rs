// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Opt-in Python source/instance view for authored swept disks.

use std::collections::HashSet;
use ifc_lite_processing::extract_swept_disk_definitions;
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::PyDict;
use super::GEOMETRY_STACK_BYTES;

/// Return reusable source definitions and occurrence transforms without meshing.
#[pyfunction]
#[pyo3(signature = (ifc_bytes, ids = None))]
pub(super) fn swept_disk_definitions(
    py: Python<'_>, ifc_bytes: Vec<u8>, ids: Option<HashSet<u32>>,
) -> PyResult<Py<PyAny>> {
    let view = py.detach(|| {
        std::thread::Builder::new()
            .stack_size(GEOMETRY_STACK_BYTES)
            .name("ifclite-swept-disk-definitions".into())
            .spawn(move || extract_swept_disk_definitions(&ifc_bytes, ids.as_ref()))
            .map_err(|error| format!("spawn failed: {error}"))?
            .join()
            .map_err(|_| "swept-disk definition worker panicked".to_string())
    }).map_err(PyRuntimeError::new_err)?;
    let json = serde_json::to_string(&view)
        .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
    let module = py.import("json")?;
    let root = module.call_method1("loads", (json,))?;
    let dict = root.cast::<PyDict>()?;
    let instances = dict.get_item("instances")?.expect("serialized instances");
    let instances = instances.cast::<PyDict>()?;
    let numbered = PyDict::new(py);
    for (key, value) in instances.iter() {
        let id = key.extract::<String>()?.parse::<u32>()
            .map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
        numbered.set_item(id, value)?;
    }
    dict.set_item("instances", numbered)?;
    Ok(root.unbind())
}
