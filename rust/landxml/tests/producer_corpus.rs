/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Licensed producer exports for #5051. These are interoperability evidence,
//! never synthetic parser vectors. They deliberately skip on a fresh clone;
//! `pnpm fixtures <path>` fetches the exact, hash-pinned source bytes.

use std::{fs, io::ErrorKind, path::PathBuf};

use ifc_lite_landxml::{parse_landxml_tin, LandXmlDiagnosticCode, LANDXML_12_NAMESPACE};

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
        let error = parse_landxml_tin(&bytes)
            .expect_err("#5051 must not fabricate a TIN from an alignment/profile-only export");
        assert_eq!(error.code, LandXmlDiagnosticCode::InvalidSemantic, "{path}");
    }
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
