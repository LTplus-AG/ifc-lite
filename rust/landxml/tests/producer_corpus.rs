/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Licensed producer exports for #5051. These are interoperability evidence,
//! never synthetic parser vectors. They deliberately skip on a fresh clone;
//! `pnpm fixtures <path>` fetches the exact, hash-pinned source bytes.

use std::{fs, io::ErrorKind, path::PathBuf};

use ifc_lite_landxml::{parse_landxml_tin, LandXmlDiagnosticCode, LANDXML_12_NAMESPACE};
use serde::Deserialize;

#[derive(Deserialize)]
struct FederationControl {
    synthetic: bool,
    #[serde(rename = "customerData")]
    customer_data: bool,
    #[serde(rename = "toleranceMetres")]
    tolerance_metres: f64,
    points: Vec<FederationControlPoint>,
}

#[derive(Deserialize)]
struct FederationControlPoint {
    id: String,
    projected: [f64; 3],
}

fn fixture(path: &str) -> Option<Vec<u8>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let absolute = root.join("tests/models").join(path);
    match fs::read(&absolute) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            eprintln!(
                "SKIP #5051 mandatory producer row (unproven): {} is absent; run `pnpm fixtures {path}`",
                absolute.display()
            );
            None
        }
        Err(error) => panic!(
            "could not read producer fixture {}: {error}",
            absolute.display()
        ),
    }
}

fn contains_ascii(bytes: &[u8], needle: &str) -> bool {
    bytes
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

#[test]
fn issue_5051_bonsai_control_landxml_matches_independent_projected_points() {
    let root = "landxml/federation/bonsai-topo-control-v1";
    let Some(control_bytes) = fixture(&format!("{root}/control.json")) else {
        return;
    };
    let Some(landxml_bytes) = fixture(&format!("{root}/terrain.xml")) else {
        return;
    };
    let control: FederationControl =
        serde_json::from_slice(&control_bytes).expect("control metadata must be valid JSON");
    assert!(control.synthetic, "the public control set must stay synthetic");
    assert!(!control.customer_data, "customer data must never enter this corpus");

    let document = ifc_lite_landxml::parse_landxml_document(&landxml_bytes)
        .expect("the rights-clear LandXML control terrain must parse canonically");
    let surface = document
        .terrain
        .surfaces
        .first()
        .expect("the control terrain must retain its TIN surface");
    assert_eq!(surface.points.len(), control.points.len());
    assert_eq!(document.plan.cogo_points().len(), control.points.len());
    for control_point in &control.points {
        let point = document
            .plan
            .cogo_points()
            .iter()
            .find(|point| point.name.as_deref() == Some(control_point.id.as_str()))
            .unwrap_or_else(|| panic!("missing control point {}", control_point.id));
        let actual = point.point.expect("control CgPoint must carry coordinates");
        let authored = [actual.easting, actual.northing, actual.elevation.unwrap_or_default()];
        for (actual, expected) in authored.into_iter().zip(control_point.projected) {
            assert!(
                (actual - expected).abs() <= control.tolerance_metres,
                "{} ordinate {actual} differs from control {expected}",
                control_point.id
            );
        }
    }
}

#[test]
fn issue_5051_canonical_producers_refuse_non_tin_exports_without_inventing_geometry() {
    let cases = [
        (
            "landxml/producers/aplitop-mdt-8.0-alignment.xml",
            "MDT",
            "8.0",
            "meter",
        ),
        (
            "landxml/producers/bentley-openroads-designer-10.09-us-survey-foot-alignment.xml",
            "OpenRoads Designer",
            "10.09.00.91",
            "USSurveyFoot",
        ),
    ];
    for (path, application, version, unit) in cases {
        let Some(bytes) = fixture(path) else {
            continue;
        };
        assert!(
            contains_ascii(&bytes, LANDXML_12_NAMESPACE),
            "{path} must be canonical LandXML 1.2"
        );
        assert!(
            contains_ascii(
                &bytes,
                &format!(r#"<Application name="{application}" version="{version}""#)
            ),
            "{path} must retain its producer/version signature"
        );
        assert!(
            contains_ascii(&bytes, &format!(r#"linearUnit="{unit}""#)),
            "{path} must retain its declared unit token"
        );
        let document = parse_landxml_tin(&bytes)
            .expect("canonical LandXML remains a valid durable source record without terrain");
        assert!(document.surfaces.is_empty(), "{path}: no TIN may be fabricated");
        assert!(!document.capabilities.renderable_tin, "{path}");
    }
}

#[test]
fn issue_5051_civil3d_2020_international_foot_tin_preserves_source_and_definition() {
    let path = "landxml/producers/autodesk-civil3d-2020-international-foot-tin.xml";
    let Some(bytes) = fixture(path) else {
        return;
    };
    assert!(contains_ascii(&bytes, r#"name="Autodesk Civil 3D""#));
    assert!(contains_ascii(&bytes, r#"version="2020""#));
    assert!(contains_ascii(&bytes, r#"linearUnit="foot""#));
    let document = parse_landxml_tin(&bytes).expect("Civil 3D LandXML 1.2 TIN must parse");
    let surface = document.surfaces.first().expect("Civil 3D source must retain its surface");
    assert!(!surface.points.is_empty(), "Pnts must not be fabricated away");
    assert!(!surface.faces.is_empty(), "Faces must not be fabricated away");
    assert!(document.capabilities.renderable_tin, "the recorded TIN must remain renderable");
}

#[test]
fn issue_5051_inframodel_producers_are_refused_before_the_profile_is_interpreted() {
    let cases = [
        (
            "landxml/producers/3d-win-6.6.4-m3-road-alignment.xml",
            "3D-Win",
            "road alignment/profile",
        ),
        (
            "landxml/producers/3d-win-6.6.4-m3-rockbed-terrain.xml",
            "3D-Win",
            "TIN SourceData/Breaklines/Pnts/Faces",
        ),
        (
            "landxml/producers/3d-win-6.6.4-m3-lighting-cgpoints.xml",
            "3D-Win",
            "CgPoints",
        ),
        (
            "landxml/producers/trimble-novapoint-21.354-drainage.xml",
            "Novapoint",
            "PipeNetworks",
        ),
    ];
    for (path, producer, feature) in cases {
        let Some(bytes) = fixture(path) else {
            continue;
        };
        assert!(
            contains_ascii(&bytes, "http://www.inframodel.fi/inframodel"),
            "{path}"
        );
        assert!(
            contains_ascii(&bytes, producer),
            "{path} must retain the {producer} signature"
        );
        let error = parse_landxml_tin(&bytes).expect_err(
            "#5051 must refuse an unsupported producer profile rather than misparse it",
        );
        // These producer files declare ISO-8859-1. The bounded parser accepts
        // UTF-8/UTF-16 only, so it refuses before it can mistake an InfraModel
        // profile for ordinary LandXML 1.2. A future decoder must update this
        // real-export assertion along with profile support.
        assert_eq!(
            error.code,
            LandXmlDiagnosticCode::InvalidXml,
            "{path}: {feature}"
        );
    }
}
