// SPDX-License-Identifier: MPL-2.0
//! Owned edge samples before production ribbon construction.
use crate::Mesh;
use nalgebra::Point3;

#[derive(Debug, Clone)]
pub(crate) struct EdgePlan {
    pub(super) points: Vec<Point3<f64>>,
}

impl EdgePlan {
    pub(crate) fn evaluate(&self) -> Mesh { super::ribbon_mesh(&self.points) }
}

#[cfg(test)]
#[path = "structural_edge_plan_tests.rs"]
mod tests;
