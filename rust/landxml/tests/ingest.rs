/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ifc_lite_landxml::{
    classify_landxml_version, parse_landxml_tin_with_cancel, LandXmlCancellationFlag,
    LandXmlDiagnosticCode, LandXmlLimits, LandXmlVersionCapability, LANDXML_10_NAMESPACE,
    LANDXML_11_NAMESPACE, LANDXML_12_NAMESPACE,
};

fn document(surface_name: &str) -> Vec<u8> {
    format!(r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="{surface_name}"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#).into_bytes()
}

fn utf16_document(little_endian: bool) -> Vec<u8> {
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-16"?><LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    let mut bytes = if little_endian {
        vec![0xff, 0xfe]
    } else {
        vec![0xfe, 0xff]
    };
    for unit in document.encode_utf16() {
        let pair = if little_endian {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        };
        bytes.extend(pair);
    }
    bytes
}

fn parse(
    bytes: &[u8],
) -> Result<ifc_lite_landxml::LandXmlTinDocument, ifc_lite_landxml::LandXmlError> {
    parse_landxml_tin_with_cancel(bytes, &LandXmlLimits::default(), None)
}

#[test]
fn parses_raw_bytes_into_durable_semantic_source_records() -> Result<(), Box<dyn std::error::Error>>
{
    let parsed = parse(&document("grade"))?;
    assert_eq!(parsed.version, "1.2");
    assert_eq!(parsed.units.linear_scale_to_meters, 1.0);
    assert_eq!(parsed.surfaces.len(), 1);
    assert_eq!(parsed.surfaces[0].source_id.0, "landxml:surface:1:grade");
    assert_eq!(
        parsed.surfaces[0].faces,
        vec![["1".to_owned(), "2".to_owned(), "3".to_owned()]]
    );
    Ok(())
}

#[test]
fn requires_exact_namespace_and_version() {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    assert_eq!(
        parse(valid.replace(LANDXML_12_NAMESPACE, "urn:vendor").as_bytes())
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::UnsupportedNamespace
    );
    assert_eq!(
        parse(
            valid
                .replace("version=\"1.2\"", "version=\"1.1\"")
                .as_bytes()
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::UnsupportedVersion
    );
    assert_eq!(
        parse(valid.replace(" version=\"1.2\"", "").as_bytes())
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::UnsupportedVersion
    );
}

#[test]
fn classifies_known_versions_but_keeps_12_as_the_only_ingest_capability() {
    assert_eq!(
        classify_landxml_version(Some(LANDXML_10_NAMESPACE), Some("1.0")),
        LandXmlVersionCapability::LandXml10Unsupported
    );
    assert_eq!(
        classify_landxml_version(Some(LANDXML_11_NAMESPACE), Some("1.1")),
        LandXmlVersionCapability::LandXml11Unsupported
    );
    assert_eq!(
        classify_landxml_version(Some(LANDXML_12_NAMESPACE), Some("1.2")),
        LandXmlVersionCapability::LandXml12Tin
    );
    assert_eq!(
        classify_landxml_version(Some(LANDXML_12_NAMESPACE), Some("1.1")),
        LandXmlVersionCapability::LandXml12VersionMismatch
    );
    assert_eq!(
        classify_landxml_version(Some("urn:vendor"), Some("1.2")),
        LandXmlVersionCapability::NotLandXml
    );
    assert!(LandXmlVersionCapability::LandXml12Tin.supports_tin_ingestion());
    assert!(!LandXmlVersionCapability::LandXml11Unsupported.supports_tin_ingestion());

    for (namespace, version) in [(LANDXML_10_NAMESPACE, "1.0"), (LANDXML_11_NAMESPACE, "1.1")] {
        let input = String::from_utf8(document("grade"))
            .expect("fixture is UTF-8")
            .replace(LANDXML_12_NAMESPACE, namespace)
            .replace("version=\"1.2\"", &format!("version=\"{version}\""));
        assert_eq!(
            parse(input.as_bytes()).unwrap_err().code,
            LandXmlDiagnosticCode::UnsupportedVersion
        );
    }
}

#[test]
fn refuses_dtd_and_entity_expansion_before_xml_parse() {
    let dtd = br#"<!DOCTYPE LandXML [<!ENTITY boom "x">]><LandXML/>"#;
    assert_eq!(
        parse(dtd).unwrap_err().code,
        LandXmlDiagnosticCode::DtdForbidden
    );
    let entity = parse(&document("grade &amp; survey")).expect("predefined entity is legal");
    assert_eq!(entity.surfaces[0].name, "grade & survey");
    let custom_entity = document("grade &custom; survey");
    assert_eq!(
        parse(&custom_entity).unwrap_err().code,
        LandXmlDiagnosticCode::EntityForbidden
    );
    let limits = LandXmlLimits {
        max_character_references: 0,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(&document("grade &amp; survey"), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
}

#[test]
fn allows_dtd_words_inside_comments_and_cdata() -> Result<(), Box<dyn std::error::Error>> {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    let input = valid.replace(
        "<Units>",
        "<!-- literal <!DOCTYPE LandXML> is not a declaration --><![CDATA[<!ENTITY safe 'text'>]]><Units>",
    );
    assert_eq!(parse(input.as_bytes())?.surfaces[0].name, "grade");
    Ok(())
}

#[test]
fn parses_utf16_le_and_be_raw_bytes() -> Result<(), Box<dyn std::error::Error>> {
    for little_endian in [true, false] {
        let parsed = parse(&utf16_document(little_endian))?;
        assert_eq!(parsed.surfaces[0].name, "grade");
        assert_eq!(parsed.surfaces[0].faces.len(), 1);
    }
    Ok(())
}

#[test]
fn enforces_limits_and_cancellation() {
    let input = document("grade");
    let limits = LandXmlLimits {
        max_points: 2,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(&input, &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    let cancelled = LandXmlCancellationFlag::new();
    cancelled.cancel();
    assert_eq!(
        parse_landxml_tin_with_cancel(&input, &LandXmlLimits::default(), Some(&cancelled))
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::Cancelled
    );
}

#[test]
fn applies_structural_and_semantic_resource_limits() {
    let input = document("grade");
    for limits in [
        LandXmlLimits {
            max_bytes: 8,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_depth: 1,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_name_bytes: 3,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_attributes: 1,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_attribute_bytes: 2,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_text_bytes: 2,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_surfaces: 0,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_faces: 0,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_references: 2,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_work: 1,
            ..LandXmlLimits::default()
        },
    ] {
        let error = parse_landxml_tin_with_cancel(&input, &limits, None).unwrap_err();
        assert!(matches!(
            error.code,
            LandXmlDiagnosticCode::InputTooLarge | LandXmlDiagnosticCode::LimitExceeded
        ));
    }
}

#[test]
fn applies_record_limits_across_all_surfaces_before_output_growth() {
    let valid = String::from_utf8(document("first")).expect("fixture is UTF-8");
    let second = valid
        .split_once("<Surfaces>")
        .and_then(|(_, remainder)| remainder.split_once("</Surfaces>"))
        .map(|(surface, _)| surface.replace("name=\"first\"", "name=\"second\""))
        .expect("fixture has one Surfaces container");
    let two_surfaces = valid.replace("</Surfaces>", &format!("{second}</Surfaces>"));

    for limits in [
        LandXmlLimits {
            max_surfaces: 1,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_points: 5,
            ..LandXmlLimits::default()
        },
        LandXmlLimits {
            max_faces: 1,
            ..LandXmlLimits::default()
        },
    ] {
        assert_eq!(
            parse_landxml_tin_with_cancel(two_surfaces.as_bytes(), &limits, None)
                .unwrap_err()
                .code,
            LandXmlDiagnosticCode::LimitExceeded
        );
    }
}

#[test]
fn ignores_extension_elements_with_landxml_local_names() -> Result<(), Box<dyn std::error::Error>> {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:vendor="urn:vendor" version="1.2"><Units><Metric linearUnit="meter"/></Units><vendor:Surface name="wrong"><Definition surfType="TIN"/></vendor:Surface><Surfaces><Surface name="right"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    assert_eq!(parse(xml.as_bytes())?.surfaces[0].name, "right");
    Ok(())
}

#[test]
fn ignores_same_namespace_geometry_outside_tin_structure() -> Result<(), Box<dyn std::error::Error>>
{
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Other><Surface name="wrong"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P></Pnts></Definition></Surface></Other><Surfaces><Surface name="right"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    assert_eq!(parse(xml.as_bytes())?.surfaces[0].name, "right");
    Ok(())
}

#[test]
fn rejects_repeated_or_mixed_unit_declarations() {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    let mixed = valid.replace(
        "<Metric linearUnit=\"meter\"/>",
        "<Metric linearUnit=\"meter\"/><Imperial linearUnit=\"foot\"/>",
    );
    assert_eq!(
        parse(mixed.as_bytes()).unwrap_err().code,
        LandXmlDiagnosticCode::InvalidSemantic
    );
}
