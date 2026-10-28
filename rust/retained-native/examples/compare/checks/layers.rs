// SPDX-License-Identifier: MPL-2.0
//! CUT-0 registration; this slice has no admitted product behavior yet.
pub(super) fn check(_: &super::ShapeOnlyProduct, _: &super::AnalyticQuantitySources, _: &serde_json::Value) -> Vec<super::OracleResult> { Vec::new() }
