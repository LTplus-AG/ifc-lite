// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7693 (B9): LandXML numerics. Every test states the invariant it holds: a
//! closed-form curve measure or an evaluator identity.

use ifc_lite_landxml::alignment::{
    parse_landxml_alignments_optional_with_cancel, LandXmlAlignment, LandXmlAlignmentLimits,
    LandXmlAlignmentPrimitive, LandXmlAlignmentSegment, LandXmlIrregularLine, LandXmlLine,
    LandXmlPlanPoint, LandXmlPointLocation, LandXmlRotation,
};
use ifc_lite_landxml::{
    parse_landxml_plan_with_cancel, parse_landxml_tin_with_cancel, LandXmlLimits,
    LandXmlParcelState, LandXmlPlanLimits, LandXmlProfileEvaluationError, LandXmlSourceId,
    LandXmlVerticalCurveKind, LANDXML_12_NAMESPACE,
};
use std::f64::consts::TAU;

mod arcs;
mod irregular;
mod profile;

#[path = "../../../export/src/test_support.rs"]
#[allow(dead_code, unused_macros)]
// shared with the export unit tests; this crate uses `fixture_opt` only
mod test_support;

fn source_id(value: &str) -> LandXmlSourceId {
    LandXmlSourceId(value.to_owned())
}

fn at(northing: f64, easting: f64) -> LandXmlPointLocation {
    LandXmlPointLocation::Coordinates {
        point: LandXmlPlanPoint {
            northing,
            easting,
            elevation: None,
        },
    }
}

fn single_segment(primitive: LandXmlAlignmentPrimitive, length: f64) -> LandXmlAlignment {
    LandXmlAlignment {
        source_id: source_id("landxml:alignment:1:a"),
        ordinal: 1,
        name: "a".to_owned(),
        length,
        sta_start: 0.0,
        start: None,
        align_pis: Vec::new(),
        segments: vec![LandXmlAlignmentSegment {
            source_id: source_id("landxml:alignment:1:segment:1"),
            ordinal: 1,
            primitive,
        }],
        station_equations: Vec::new(),
        cant: None,
        superelevations: Vec::new(),
        unsupported_transitions: Vec::new(),
    }
}

fn plan_document(body: &str) -> String {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter" areaUnit="squareMeter"/></Units>{body}</LandXML>"#
    )
}

/// A producer file read as the LandXML 1.2 document it is. 3D-Win declares
/// ISO-8859-1 (refused before parsing, #5051) and the InfraModel namespace,
/// but its bytes are ASCII, so only those two labels change.
fn producer_as_landxml_12(path: &str) -> Option<String> {
    let bytes = test_support::fixture_opt(path)?;
    let text = String::from_utf8(bytes).expect("producer fixture is UTF-8 or ASCII");
    Some(
        text.trim_start_matches('\u{feff}')
            .replace(r#"encoding="ISO-8859-1""#, r#"encoding="UTF-8""#)
            .replace("http://www.inframodel.fi/inframodel", LANDXML_12_NAMESPACE),
    )
}
