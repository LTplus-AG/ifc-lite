// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Python view of the shared Rust reinforcing-bar schedule.

use std::collections::HashSet;

use ifc_lite_export::{build_rebar_schedule, AuthoredRebarValue, RebarSchedule};
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
    validate_finite(&schedule).map_err(PyValueError::new_err)?;
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

/// JSON encodes non-finite floats as null, violating the Python type surface.
fn validate_finite(schedule: &RebarSchedule) -> Result<(), String> {
    fn finite(value: f64, path: &str) -> Result<(), String> {
        if value.is_finite() {
            Ok(())
        } else {
            Err(format!("{path} is non-finite"))
        }
    }

    finite(schedule.length_unit_scale, "rebar schedule length_unit_scale")?;
    for (id, row) in &schedule.rows {
        for (name, attribute) in &row.authored {
            if let AuthoredRebarValue::Measure {
                value_file_units,
                value_si,
                ..
            } = &attribute.value
            {
                finite(*value_file_units, &format!("rebar #{id} {name} value_file_units"))?;
                finite(*value_si, &format!("rebar #{id} {name} value_si"))?;
            }
        }
        for sweep in &row.sweeps {
            let path = format!("rebar #{id} sweep {}", sweep.occurrence_index);
            finite(sweep.radius_m, &format!("{path} radius_m"))?;
            if let Some(radius) = sweep.inner_radius_m {
                finite(radius, &format!("{path} inner_radius_m"))?;
            }
            if let Some(metrics) = &sweep.directrix_metrics {
                finite(metrics.total_length, &format!("{path} directrix_metrics.total_length"))?;
                for segment in &metrics.segments {
                    let segment_path = format!(
                        "{path} directrix_metrics.segments[{}]", segment.segment_index
                    );
                    finite(segment.length, &format!("{segment_path}.length"))?;
                    if let Some(angle) = segment.bend_angle {
                        finite(angle, &format!("{segment_path}.bend_angle"))?;
                    }
                }
            }
            for (index, finding) in sweep.checks.findings.iter().enumerate() {
                finite(finding.measured, &format!("{path} checks.findings[{index}].measured"))?;
                finite(finding.threshold, &format!("{path} checks.findings[{index}].threshold"))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_5801_nested_metrics_cannot_be_serialized_as_null() {
        let ifc = include_bytes!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
        let mut schedule = build_rebar_schedule(ifc, None, &SweptDiskCheckOptions::default()).unwrap();
        assert!(validate_finite(&schedule).is_ok());

        let sweep = &mut schedule.rows.get_mut(&125).unwrap().sweeps[0];
        let metrics = sweep.directrix_metrics.as_mut().unwrap();
        metrics.total_length = f64::INFINITY;
        assert_eq!(
            validate_finite(&schedule).unwrap_err(),
            "rebar #125 sweep 0 directrix_metrics.total_length is non-finite"
        );

        let metrics = schedule.rows.get_mut(&125).unwrap().sweeps[0].directrix_metrics.as_mut().unwrap();
        metrics.total_length = 1.0;
        metrics.segments[0].length = f64::NAN;
        assert_eq!(
            validate_finite(&schedule).unwrap_err(),
            "rebar #125 sweep 0 directrix_metrics.segments[0].length is non-finite"
        );

        let metrics = schedule.rows.get_mut(&125).unwrap().sweeps[0].directrix_metrics.as_mut().unwrap();
        metrics.segments[0].length = 1.0;
        let arc = metrics.segments.iter_mut().find(|segment| segment.bend_angle.is_some()).unwrap();
        let arc_index = arc.segment_index;
        arc.bend_angle = Some(f64::NEG_INFINITY);
        assert_eq!(
            validate_finite(&schedule).unwrap_err(),
            format!("rebar #125 sweep 0 directrix_metrics.segments[{arc_index}].bend_angle is non-finite")
        );
    }

    #[test]
    fn issue_5801_other_numeric_schedule_fields_cannot_become_null() {
        let ifc = include_bytes!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
        let mut options = SweptDiskCheckOptions::default();
        options.zero_length_tolerance_m = 1_000.0;
        let mut schedule = build_rebar_schedule(ifc, None, &options).unwrap();
        assert!(validate_finite(&schedule).is_ok());

        schedule.length_unit_scale = f64::INFINITY;
        assert_eq!(validate_finite(&schedule).unwrap_err(), "rebar schedule length_unit_scale is non-finite");
        schedule.length_unit_scale = 0.001;

        if let AuthoredRebarValue::Measure { value_si, .. } =
            &mut schedule.rows.get_mut(&125).unwrap().authored.get_mut("CrossSectionArea").unwrap().value
        {
            *value_si = f64::NAN;
        } else {
            panic!("fixture CrossSectionArea must be a measure");
        }
        assert_eq!(validate_finite(&schedule).unwrap_err(), "rebar #125 CrossSectionArea value_si is non-finite");
        schedule = build_rebar_schedule(ifc, None, &options).unwrap();

        schedule.rows.get_mut(&125).unwrap().sweeps[0].checks.findings[0].measured = f64::NEG_INFINITY;
        assert_eq!(validate_finite(&schedule).unwrap_err(), "rebar #125 sweep 0 checks.findings[0].measured is non-finite");
        let finding = &mut schedule.rows.get_mut(&125).unwrap().sweeps[0].checks.findings[0];
        finding.measured = 0.322;
        finding.threshold = f64::INFINITY;
        assert_eq!(validate_finite(&schedule).unwrap_err(), "rebar #125 sweep 0 checks.findings[0].threshold is non-finite");
    }
}
