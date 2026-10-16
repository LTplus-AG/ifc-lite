// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Python view of the shared Rust reinforcing-bar schedule.

use std::collections::HashSet;

use ifc_lite_export::{
    build_rebar_schedule, build_rebar_schedule_with_fabrication_precheck,
    build_rebar_schedule_with_preflight, RebarFabricationPolicy,
    RebarPreflightLimits,
};
use ifc_lite_processing::SweptDiskCheckOptions;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;

use super::run_geometry;

enum ScheduleMode {
    Basic,
    Preflight(RebarPreflightLimits),
    Fabrication(RebarFabricationPolicy),
}

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
    schedule_impl(py, ifc_bytes, ids, zero_length_tolerance_m,
        gap_tolerance_m, tangent_tolerance_rad, ScheduleMode::Basic)
}

/// Assess represented source sweeps against caller-provided project limits.
#[pyfunction]
#[pyo3(signature = (ifc_bytes, min_inside_bend_radius_m, min_straight_segment_length_m, ids = None, *, max_developed_centreline_length_m = None, zero_length_tolerance_m = 1e-9, gap_tolerance_m = 1e-6, tangent_tolerance_rad = 1e-6))]
#[allow(clippy::too_many_arguments)]
pub(super) fn rebar_schedule_with_preflight(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    min_inside_bend_radius_m: f64,
    min_straight_segment_length_m: f64,
    ids: Option<HashSet<u32>>,
    max_developed_centreline_length_m: Option<f64>,
    zero_length_tolerance_m: f64,
    gap_tolerance_m: f64,
    tangent_tolerance_rad: f64,
) -> PyResult<Py<PyAny>> {
    let limits = RebarPreflightLimits::new(min_inside_bend_radius_m,
        min_straight_segment_length_m, max_developed_centreline_length_m)
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    schedule_impl(py, ifc_bytes, ids, zero_length_tolerance_m,
        gap_tolerance_m, tangent_tolerance_rad, ScheduleMode::Preflight(limits))
}

/// Return only the caller-requested SI comparisons, with source provenance.
#[pyfunction]
#[pyo3(signature = (ifc_bytes, ids = None, *, min_inside_bend_radius_m = None,
    min_straight_segment_length_m = None, min_bend_angle_rad = None,
    max_bend_angle_rad = None, max_nominal_geometric_diameter_delta_m = None,
    max_developed_centreline_length_m = None, zero_length_tolerance_m = 1e-9,
    gap_tolerance_m = 1e-6, tangent_tolerance_rad = 1e-6))]
#[allow(clippy::too_many_arguments)]
pub(super) fn rebar_schedule_with_fabrication_precheck(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    ids: Option<HashSet<u32>>,
    min_inside_bend_radius_m: Option<f64>,
    min_straight_segment_length_m: Option<f64>,
    min_bend_angle_rad: Option<f64>,
    max_bend_angle_rad: Option<f64>,
    max_nominal_geometric_diameter_delta_m: Option<f64>,
    max_developed_centreline_length_m: Option<f64>,
    zero_length_tolerance_m: f64,
    gap_tolerance_m: f64,
    tangent_tolerance_rad: f64,
) -> PyResult<Py<PyAny>> {
    let allowed_bend_angle_rad = match (min_bend_angle_rad, max_bend_angle_rad) {
        (None, None) => None,
        (Some(minimum), Some(maximum)) => Some([minimum, maximum]),
        _ => return Err(PyValueError::new_err(
            "min_bend_angle_rad and max_bend_angle_rad must be supplied together")),
    };
    let mut policy = RebarFabricationPolicy::default();
    policy.min_inside_bend_radius_m = min_inside_bend_radius_m;
    policy.min_straight_segment_length_m = min_straight_segment_length_m;
    policy.allowed_bend_angle_rad = allowed_bend_angle_rad;
    policy.max_nominal_geometric_diameter_delta_m = max_nominal_geometric_diameter_delta_m;
    policy.max_developed_centreline_length_m = max_developed_centreline_length_m;
    policy.validate().map_err(|error| PyValueError::new_err(error.to_string()))?;
    schedule_impl(py, ifc_bytes, ids, zero_length_tolerance_m, gap_tolerance_m,
        tangent_tolerance_rad, ScheduleMode::Fabrication(policy))
}

#[allow(clippy::too_many_arguments)]
fn schedule_impl(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    ids: Option<HashSet<u32>>,
    zero_length_tolerance_m: f64,
    gap_tolerance_m: f64,
    tangent_tolerance_rad: f64,
    mode: ScheduleMode,
) -> PyResult<Py<PyAny>> {
    let mut options = SweptDiskCheckOptions::default();
    options.zero_length_tolerance_m = zero_length_tolerance_m;
    options.gap_tolerance_m = gap_tolerance_m;
    options.tangent_tolerance_rad = tangent_tolerance_rad;
    options
        .validate()
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    let schedule = run_geometry(py, "rebar schedule", move || match mode {
        ScheduleMode::Preflight(limits) => build_rebar_schedule_with_preflight(&ifc_bytes, ids.as_ref(), &options, &limits)
            .map_err(|error| error.to_string()),
        ScheduleMode::Fabrication(policy) => build_rebar_schedule_with_fabrication_precheck(
            &ifc_bytes, ids.as_ref(), &options, &policy)
            .map_err(|error| error.to_string()),
        ScheduleMode::Basic => build_rebar_schedule(&ifc_bytes, ids.as_ref(), &options)
            .map_err(|error| error.to_string()),
    })?
    .map_err(PyRuntimeError::new_err)?;
    let payload = crate::finite_json::to_json_string(&schedule)?;
    let decoded = py.import("json")?.getattr("loads")?.call1((payload,))?;
    let rows = decoded.get_item("rows")?;
    let keyed = PyDict::new(py);
    for id in schedule.rows.keys() {
        keyed.set_item(*id, rows.get_item(id.to_string())?)?;
    }
    decoded.set_item("rows", keyed)?;
    Ok(decoded.unbind())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ifc_lite_export::{AuthoredRebarValue, RebarSchedule};

    /// The location in the `finite_json` refusal for a schedule, as the Python entry point would raise it.
    pub(crate) fn non_finite(schedule: &RebarSchedule) -> String {
        let message = crate::finite_json::ensure_finite(schedule).unwrap_err().to_string();
        message.split(" (").next().unwrap_or_default().to_string()
    }

    #[test]
    fn issue_5797_fabrication_nested_measurements_cannot_become_json_null() {
        let ifc = include_bytes!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
        let mut policy = RebarFabricationPolicy::default();
        policy.min_inside_bend_radius_m = Some(0.01);
        let mut schedule = build_rebar_schedule_with_fabrication_precheck(
            ifc, None, &SweptDiskCheckOptions::default(), &policy,
        ).unwrap();
        let check = &mut schedule.rows.get_mut(&125).unwrap().sweeps[0]
            .fabrication_precheck.as_mut().unwrap().checks[0];
        check.measured = Some(f64::NAN);
        assert!(non_finite(&schedule).contains("fabrication_precheck.checks[0].measured"));
    }

    #[test]
    fn issue_5801_nested_metrics_cannot_be_serialized_as_null() {
        let ifc = include_bytes!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
        let mut schedule = build_rebar_schedule(ifc, None, &SweptDiskCheckOptions::default()).unwrap();
        assert!(crate::finite_json::ensure_finite(&schedule).is_ok());

        let sweep = &mut schedule.rows.get_mut(&125).unwrap().sweeps[0];
        let metrics = sweep.directrix_metrics.as_mut().unwrap();
        metrics.total_length = f64::INFINITY;
        assert_eq!(
            non_finite(&schedule),
            "rows.{}.sweeps[0].directrix_metrics.total_length is non-finite"
        );

        let metrics = schedule.rows.get_mut(&125).unwrap().sweeps[0].directrix_metrics.as_mut().unwrap();
        metrics.total_length = 1.0;
        metrics.segments[0].length = f64::NAN;
        assert_eq!(
            non_finite(&schedule),
            "rows.{}.sweeps[0].directrix_metrics.segments[0].length is non-finite"
        );

        let metrics = schedule.rows.get_mut(&125).unwrap().sweeps[0].directrix_metrics.as_mut().unwrap();
        metrics.segments[0].length = 1.0;
        let arc = metrics.segments.iter_mut().find(|segment| segment.bend_angle.is_some()).unwrap();
        let arc_index = arc.segment_index;
        arc.bend_angle = Some(f64::NEG_INFINITY);
        assert_eq!(
            non_finite(&schedule),
            format!("rows.{{}}.sweeps[0].directrix_metrics.segments[{arc_index}].bend_angle is non-finite")
        );
    }

    #[test]
    fn issue_5801_other_numeric_schedule_fields_cannot_become_null() {
        let ifc = include_bytes!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
        let mut options = SweptDiskCheckOptions::default();
        options.zero_length_tolerance_m = 1_000.0;
        let mut schedule = build_rebar_schedule(ifc, None, &options).unwrap();
        assert!(crate::finite_json::ensure_finite(&schedule).is_ok());

        schedule.length_unit_scale = f64::INFINITY;
        assert_eq!(non_finite(&schedule), "length_unit_scale is non-finite");
        schedule.length_unit_scale = 0.001;

        if let AuthoredRebarValue::Measure { value_si, .. } =
            &mut schedule.rows.get_mut(&125).unwrap().authored.get_mut("CrossSectionArea").unwrap().value
        {
            *value_si = f64::NAN;
        } else {
            panic!("fixture CrossSectionArea must be a measure");
        }
        assert_eq!(non_finite(&schedule), "rows.{}.authored.{}.value.value_si is non-finite");
        schedule = build_rebar_schedule(ifc, None, &options).unwrap();

        schedule.rows.get_mut(&125).unwrap().sweeps[0].checks.findings[0].measured = f64::NEG_INFINITY;
        assert_eq!(non_finite(&schedule), "rows.{}.sweeps[0].checks.findings[0].measured is non-finite");
        let finding = &mut schedule.rows.get_mut(&125).unwrap().sweeps[0].checks.findings[0];
        finding.measured = 0.322;
        finding.threshold = f64::INFINITY;
        assert_eq!(non_finite(&schedule), "rows.{}.sweeps[0].checks.findings[0].threshold is non-finite");
    }

}

#[cfg(test)]
#[path = "rebar_schedule_tests.rs"]
mod preflight_tests;
