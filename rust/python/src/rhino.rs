// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Thin Python adapter over the shared Rhino scene exporter.
use ifc_lite_export::rhino::{build_rhino_scene, RhinoSceneOptions};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};
use serde::de::DeserializeOwned;

fn option<T: DeserializeOwned>(name: &str, value: Option<&str>, default: T) -> PyResult<T> {
    value.map(|value| {
        let deserializer = serde::de::value::StrDeserializer::<serde::de::value::Error>::new(value);
        T::deserialize(deserializer)
            .map_err(|error| PyValueError::new_err(format!("invalid {name}: {error}")))
    }).transpose().map(|value| value.unwrap_or(default))
}

/// Build a deterministic Rhino scene: manifest JSON and little-endian mesh blob.
/// Invalid options or a model without render geometry raise ValueError.
/// Geometry runs with the GIL released on the large-stack geometry pool.
#[pyfunction]
#[pyo3(signature = (ifc_bytes, *, units=None, coordinates=None, layer_scheme=None, instancing=None, properties=None, include_spaces=None, normals=None, layer_slicing=None))]
#[allow(clippy::too_many_arguments)]
pub(super) fn rhino_scene(
    py: Python<'_>, ifc_bytes: &[u8], units: Option<&str>, coordinates: Option<&str>,
    layer_scheme: Option<&str>, instancing: Option<bool>, properties: Option<&str>,
    include_spaces: Option<bool>, normals: Option<bool>, layer_slicing: Option<bool>,
) -> PyResult<Py<PyAny>> {
    let defaults = RhinoSceneOptions::default();
    let options = RhinoSceneOptions {
        units: option("units", units, defaults.units)?,
        coordinates: option("coordinates", coordinates, defaults.coordinates)?,
        layer_scheme: option("layer_scheme", layer_scheme, defaults.layer_scheme)?,
        properties: option("properties", properties, defaults.properties)?,
        instancing: instancing.unwrap_or(defaults.instancing),
        include_spaces: include_spaces.unwrap_or(defaults.include_spaces),
        normals: normals.unwrap_or(defaults.normals),
        layer_slicing: layer_slicing.unwrap_or(defaults.layer_slicing),
        ..defaults
    };
    let (manifest, blob) = super::run_geometry(py, "Rhino scene", || {
        build_rhino_scene(ifc_bytes, &options).map(|scene| scene.encode())
    })?.map_err(|error| PyValueError::new_err(error.to_string()))?;
    let out = PyDict::new(py);
    out.set_item("manifest", manifest)?;
    out.set_item("blob", PyBytes::new(py, &blob))?;
    Ok(out.into_any().unbind())
}
