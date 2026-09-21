// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded display sampling for analytic alignment primitives.

use super::{
    diagnostic, geometry::evaluate_segment, geometry::validate_segment, LandXmlNumericDiagnostic,
};
use crate::{
    alignment::{LandXmlAlignmentPrimitive, LandXmlAlignmentSegment, LandXmlPlanPoint},
    LandXmlSourceId,
};

/// A bounded display polyline for one analytic source primitive. Numeric
/// probes remain authoritative; these samples exist only for overlay/picking.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct LandXmlAlignmentRenderSpan {
    pub source_id: LandXmlSourceId,
    pub points: Vec<LandXmlPlanPoint>,
}

impl LandXmlAlignmentSegment {
    /// Sample supported analytic primitives through the canonical evaluator.
    /// Authored lines/polylines are already retained verbatim by the source
    /// document and unsupported transitions deliberately return no geometry.
    pub fn render_span(
        &self,
        point_count: usize,
    ) -> Result<Option<LandXmlAlignmentRenderSpan>, LandXmlNumericDiagnostic> {
        match &self.primitive {
            LandXmlAlignmentPrimitive::Curve(_) | LandXmlAlignmentPrimitive::Spiral(_) => {}
            LandXmlAlignmentPrimitive::Line(_)
            | LandXmlAlignmentPrimitive::IrregularLine(_)
            | LandXmlAlignmentPrimitive::UnsupportedSpiral(_) => return Ok(None),
        }
        if point_count < 2 {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA231",
                "render sampling requires at least two points",
            ));
        }
        let length = validate_segment(self)?;
        let mut points = Vec::with_capacity(point_count);
        for index in 0..point_count {
            let distance = length * index as f64 / (point_count - 1) as f64;
            points.push(evaluate_segment(self, distance)?.0);
        }
        Ok(Some(LandXmlAlignmentRenderSpan {
            source_id: self.source_id.clone(),
            points,
        }))
    }
}
