/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ifc_lite_landxml::{
    classify_landxml_version, parse_landxml_tin_with_cancel, LandXmlCancellation,
    LandXmlCancellationFlag, LandXmlDiagnosticCode, LandXmlLimits, LandXmlVersionCapability,
    LANDXML_10_NAMESPACE, LANDXML_11_NAMESPACE, LANDXML_12_NAMESPACE,
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CancelsAfterPolls {
    cancel_after: usize,
    polls: AtomicUsize,
}

impl CancelsAfterPolls {
    fn new(cancel_after: usize) -> Self {
        Self {
            cancel_after,
            polls: AtomicUsize::new(0),
        }
    }
    fn polls(&self) -> usize {
        self.polls.load(Ordering::Relaxed)
    }
}

impl LandXmlCancellation for CancelsAfterPolls {
    fn is_cancelled(&self) -> bool {
        self.polls.fetch_add(1, Ordering::Relaxed) >= self.cancel_after
    }
}

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

fn utf16_le(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xfe];
    for unit in text.encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    bytes
}

fn padded_document(padding_bytes: usize) -> String {
    let document = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    format!("<!--{}-->{document}", "x".repeat(padding_bytes))
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
    assert_eq!(
        parsed
            .units
            .as_ref()
            .expect("fixture has units")
            .linear_scale_to_meters,
        1.0
    );
    assert_eq!(parsed.surfaces.len(), 1);
    assert_eq!(parsed.surfaces[0].source_id.0, "landxml:surface:1");
    assert_eq!(
        parsed.surfaces[0].faces,
        vec![["1".to_owned(), "2".to_owned(), "3".to_owned()]]
    );
    Ok(())
}

#[test]
fn retains_source_terrain_records_without_guessing_grid_topology(
) -> Result<(), Box<dyn std::error::Error>> {
    let xml = format!(
        r#"
<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:vendor="urn:survey-vendor" version="1.2">
  <Units><Metric linearUnit="meter"/></Units>
  <Surfaces>
    <Surface name="EG"><Definition surfType="TIN"><Pnts>
      <P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P>
    </Pnts><Faces><F>1 2 3</F><F i="true">1 3 2</F></Faces>
    </Definition><SourceData><DataPoints><PntList3D>0 0 0 0 1 0</PntList3D></DataPoints>
    <Boundaries><Boundary name="Outer" bndType="outer" edgeTrim="true"><PntList3D>0 0 0 0 1 0</PntList3D></Boundary></Boundaries>
    <Breaklines><Breakline name="Crown" brkType="standard"><PntList2D>0 0 1 1</PntList2D></Breakline></Breaklines>
    <Contours><Contour name="Index" contType="major"><PntList3D>0 0 0 1 0 0</PntList3D></Contour></Contours>
    </SourceData></Surface>
    <Surface name="Grid"><Definition surfType="GRID"/></Surface>
  </Surfaces>
  <vendor:ProducerSetting value="kept-as-a-record"/>
</LandXML>"#
    );
    let parsed = parse(xml.as_bytes())?;
    let tin = &parsed.surfaces[0];
    assert_eq!(tin.source_id.0, "landxml:surface:1");
    assert_eq!(tin.ordinal, 1);
    assert_eq!(tin.source_path, "LandXML/Surfaces/Surface[1]");
    assert_eq!(tin.properties.get("name").map(String::as_str), Some("EG"));
    assert_eq!(
        tin.definition_properties
            .get("surfType")
            .map(String::as_str),
        Some("TIN")
    );
    assert_eq!(tin.points[0].source_id.0, "landxml:surface:1:point:1");
    assert_eq!(tin.face_source_ids[0].0, "landxml:surface:1:face:1");
    assert_eq!(tin.hidden_face_count, 1);
    assert_eq!(tin.face_visibility, vec![true, false]);
    assert_eq!(tin.source_data_points.len(), 2);
    assert_eq!(
        tin.source_data_points[0].source_id.0,
        "landxml:surface:1:source-point:1"
    );
    assert_eq!(
        tin.boundaries[0].source_id.0,
        "landxml:surface:1:boundary:1"
    );
    assert_eq!(tin.boundaries[0].name.as_deref(), Some("Outer"));
    assert_eq!(tin.boundaries[0].kind.as_deref(), Some("outer"));
    assert_eq!(
        tin.boundaries[0]
            .properties
            .get("edgeTrim")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(
        tin.breaklines[0].source_id.0,
        "landxml:surface:1:breakline:1"
    );
    assert_eq!(tin.breaklines[0].name.as_deref(), Some("Crown"));
    assert_eq!(tin.breaklines[0].coordinate_dimension, 2);
    assert_eq!(
        tin.breaklines[0].point_source_ids[0].0,
        "landxml:surface:1:breakline:1:point:1"
    );
    assert_eq!(tin.contours[0].source_id.0, "landxml:surface:1:contour:1");
    assert_eq!(tin.contours[0].kind.as_deref(), Some("major"));
    assert_eq!(
        parsed.surfaces[1].render_state,
        ifc_lite_landxml::LandXmlRenderState::PreservedOnly
    );
    assert_eq!(parsed.extensions[0].namespace, "urn:survey-vendor");
    assert_eq!(parsed.extensions[0].path, "LandXML/ProducerSetting");
    assert!(parsed
        .warnings
        .iter()
        .any(|warning| warning.contains("1 unknown vendor extension")));
    assert!(parsed.capabilities.renderable_tin);
    assert_eq!(parsed.capabilities.preserved_only_surfaces, 1);
    Ok(())
}

#[test]
fn retains_geometry_free_documents_as_honest_source_records(
) -> Result<(), Box<dyn std::error::Error>> {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Surfaces><Surface name="survey-only"><Definition surfType="VOLUME"/></Surface></Surfaces></LandXML>"#
    );
    let parsed = parse(xml.as_bytes())?;
    assert!(parsed.units.is_none());
    assert_eq!(parsed.surfaces.len(), 1);
    assert_eq!(
        parsed.surfaces[0].render_state,
        ifc_lite_landxml::LandXmlRenderState::PreservedOnly
    );
    Ok(())
}

#[test]
fn bounds_preserved_vendor_extension_roots() {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" xmlns:v="urn:vendor" version="1.2"><Units><Metric linearUnit="meter"/></Units><v:One/><v:Two/></LandXML>"#
    );
    let limits = LandXmlLimits {
        max_extensions: 1,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_tin_with_cancel(xml.as_bytes(), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded,
    );
}

#[test]
fn bounds_source_data_and_overlay_vertices_with_the_global_point_limit() {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Surfaces><Surface name="survey"><Definition surfType="VOLUME"/><SourceData><DataPoints><PntList3D>0 0 0 1 1 1</PntList3D></DataPoints><Breaklines><Breakline><PntList2D>0 0 1 1</PntList2D></Breakline></Breaklines></SourceData></Surface></Surfaces></LandXML>"#
    );
    for max_points in [1, 2, 3] {
        let error = parse_landxml_tin_with_cancel(
            xml.as_bytes(),
            &LandXmlLimits {
                max_points,
                ..LandXmlLimits::default()
            },
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, LandXmlDiagnosticCode::LimitExceeded);
    }
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
fn allows_an_xml_stylesheet_processing_instruction_before_the_root() {
    let valid = String::from_utf8(document("grade")).expect("fixture is UTF-8");
    let input = format!("<?xml-stylesheet type=\"text/xsl\" href=\"terrain.xsl\"?>{valid}");
    assert_eq!(parse(input.as_bytes()).unwrap().surfaces.len(), 1);
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
fn cancels_mid_normalization_of_a_large_utf8_source() {
    // The cancellation fires on the fourth poll: after three full 4 KiB
    // chunks, while the UTF-8 normalizer is still copying/validating input.
    let cancelled = CancelsAfterPolls::new(3);
    let input = padded_document(32 * 1024);
    assert_eq!(
        parse_landxml_tin_with_cancel(
            input.as_bytes(),
            &LandXmlLimits::default(),
            Some(&cancelled)
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::Cancelled
    );
    assert_eq!(cancelled.polls(), 4);
}

#[test]
fn rejects_a_continuation_byte_run_at_a_utf8_chunk_boundary() {
    // The normalizer must not rewind an entire 4 KiB chunk and then retry the
    // same empty slice forever when untrusted input is all continuation bytes.
    let input = vec![0x80; 4 * 1024 + 1];
    assert_eq!(
        parse(&input).unwrap_err().code,
        LandXmlDiagnosticCode::InvalidXml
    );
}

#[test]
fn cancels_mid_preflight_scan_of_a_large_utf16_source() {
    // UTF-16 decoding consumes eight 4 KiB raw chunks first. The next poll is
    // the scanner's initial guard and the following one is inside its long
    // comment, proving that pre-quick-xml scanning is also interruptible.
    let cancelled = CancelsAfterPolls::new(10);
    let input = utf16_le(&padded_document(16 * 1024));
    assert_eq!(
        parse_landxml_tin_with_cancel(&input, &LandXmlLimits::default(), Some(&cancelled))
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::Cancelled
    );
    assert_eq!(cancelled.polls(), 11);
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

#[test]
fn issue_5042_uses_the_schema_default_for_omitted_elevation_units() {
    let source = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Imperial linearUnit="foot"/></Units></LandXML>"#
    );
    let document = parse(source.as_bytes()).expect("valid LandXML");
    let units = document.units.expect("units");

    assert_eq!(units.linear_unit, "foot");
    assert_eq!(units.linear_scale_to_meters, 0.3048);
    assert_eq!(units.elevation_unit, "meter");
    assert_eq!(units.elevation_scale_to_meters, 1.0);
}

#[test]
fn issue_5042_rejects_empty_or_whitespace_only_documents() {
    for input in [b"".as_slice(), b" \n\t".as_slice()] {
        assert_eq!(
            parse(input).unwrap_err().code,
            LandXmlDiagnosticCode::InvalidXml
        );
    }
}
