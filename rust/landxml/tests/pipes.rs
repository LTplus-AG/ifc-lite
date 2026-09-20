// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_landxml::{
    parse_landxml_pipe_networks, parse_landxml_pipe_networks_with_cancel, LandXmlCancellationFlag,
    LandXmlDiagnosticCode, LandXmlLimits, LandXmlPipeGeometry, LandXmlPipePart,
    LANDXML_12_NAMESPACE,
};

fn document(units: &str, pipes: &str) -> String {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units>{units}</Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="MH-1" elevRim="12" elevSump="9"><Center>0 0 10</Center><CircStruct diameter="1.2" material="concrete"/><Invert refPipe="P-1" flowDir="out" elev="9.5"/><StructFlow lossIn="0.1" lossOut="0.2"/></Struct><Struct name="MH-2"><Center>0 10 8</Center><RectStruct length="2" width="1"/><Invert refPipe="P-1" flowDir="in" elev="7.5"/></Struct></Structs><Pipes>{pipes}</Pipes></PipeNetwork></PipeNetworks></LandXML>"#
    )
}

#[test]
fn records_network_topology_parts_flows_and_source_provenance(
) -> Result<(), Box<dyn std::error::Error>> {
    let xml = document(
        r#"<Metric linearUnit="meter" elevationUnit="meter" diameterUnit="millimeter" widthUnit="centimeter" heightUnit="meter"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2" length="12.5" slope="0.1"><CircPipe diameter="600" thickness="20" material="PVC"/><PipeFlow flowIn="4.2"/></Pipe>"#,
    );
    let parsed = parse_landxml_pipe_networks(xml.as_bytes())?;
    assert_eq!(parsed.networks.len(), 1);
    assert!(parsed.refusals.is_empty());
    let network = &parsed.networks[0];
    assert_eq!(network.source_id.0, "landxml:pipe-network:1:1");
    assert_eq!(
        network.source_path,
        "LandXML/PipeNetworks[1]/PipeNetwork[1]"
    );
    assert_eq!(
        network.structures[0].source_id.0,
        "landxml:pipe-network:1:1:structure:1"
    );
    assert_eq!(
        network.structures[0].inverts[0].pipe_source_id,
        network.pipes[0].source_id
    );
    assert_eq!(
        parsed
            .source_batches(2)
            .iter()
            .map(|batch| batch.source_ids.len())
            .sum::<usize>(),
        8
    );
    assert_eq!(
        network.pipes[0].connectivity.start_structure_source_id,
        network.structures[0].source_id
    );
    assert_eq!(
        network.pipes[0].connectivity.end_structure_source_id,
        network.structures[1].source_id
    );
    assert_eq!(
        network.pipes[0].flow.as_ref().map(|flow| flow.flow_in),
        Some(Some(4.2))
    );
    assert_eq!(
        network.structures[0]
            .flow
            .as_ref()
            .map(|flow| flow.loss_out),
        Some(Some(0.2))
    );
    assert_eq!(network.structures[0].inverts[0].elevation.meters, 9.5);
    match &network.pipes[0].part {
        LandXmlPipePart::Circular {
            diameter,
            thickness,
            material,
            properties,
        } => {
            assert_eq!(diameter.meters, 0.6);
            assert_eq!(thickness.as_ref().map(|value| value.meters), Some(0.02));
            assert_eq!(material.as_deref(), Some("PVC"));
            assert_eq!(properties.get("diameter").map(String::as_str), Some("600"));
        }
        _ => panic!("fixture declares CircPipe"),
    }
    Ok(())
}

#[test]
fn preserves_international_and_us_survey_foot_scales_for_curved_pipe_measures(
) -> Result<(), Box<dyn std::error::Error>> {
    let xml = document(
        r#"<Imperial linearUnit="foot" elevationUnit="USSurveyFoot" diameterUnit="inch" widthUnit="foot" heightUnit="foot"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2" length="10"><ElliPipe span="2" height="3"/><Center>4 5 6</Center></Pipe>"#,
    );
    let parsed = parse_landxml_pipe_networks(xml.as_bytes())?;
    let pipe = &parsed.networks[0].pipes[0];
    assert_eq!(
        pipe.length.as_ref().map(|length| length.meters),
        Some(3.048)
    );
    assert!(
        (parsed.networks[0].structures[0].inverts[0].elevation.meters - (9.5 * 1200.0 / 3937.0))
            .abs()
            < 1e-12
    );
    match &pipe.geometry {
        LandXmlPipeGeometry::PassThrough { point } => assert!(
            (point
                .elevation
                .as_ref()
                .map(|value| value.meters)
                .expect("route point has elevation")
                - (6.0 * 1200.0 / 3937.0))
                .abs()
                < 1e-12
        ),
        _ => panic!("fixture declares a route pass-through point"),
    }
    match &pipe.part {
        LandXmlPipePart::Elliptical { span, height, .. } => {
            assert!((span.meters - 0.6096).abs() < 1e-12);
            assert!((height.meters - 0.9144).abs() < 1e-12);
        }
        _ => panic!("fixture declares ElliPipe"),
    }
    Ok(())
}

#[test]
fn refuses_invalid_or_dangling_elements_without_fabricating_pipes(
) -> Result<(), Box<dyn std::error::Error>> {
    let xml = document(
        r#"<Metric linearUnit="meter"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="0.5"/></Pipe><Pipe name="lost" refStart="MH-1" refEnd="missing"><CircPipe diameter="0.5"/></Pipe><Pipe name="bad" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="0"/></Pipe><Pipe name="thin" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="0.5" thickness="-1"/></Pipe><Pipe name="channel" refStart="MH-1" refEnd="MH-2"><Channel height="1" widthTop="2" widthBottom="1"/></Pipe>"#,
    );
    let parsed = parse_landxml_pipe_networks(xml.as_bytes())?;
    assert_eq!(parsed.networks[0].pipes.len(), 1);
    assert_eq!(parsed.networks[0].pipes[0].name, "P-1");
    assert_eq!(parsed.refusals.len(), 4);
    assert!(parsed
        .refusals
        .iter()
        .all(|refusal| refusal.code == LandXmlDiagnosticCode::InvalidSemantic));
    assert!(parsed
        .refusals
        .iter()
        .all(|refusal| refusal.source_path.contains("/Pipe[")));
    Ok(())
}

#[test]
fn ignores_foreign_namespace_pipe_lookalikes_and_enforces_pipe_limits() {
    let valid_pipe =
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="0.5"/></Pipe>"#;
    let xml = document(
        r#"<Metric linearUnit="meter"/>"#,
        &format!(
            r#"<vendor:Pipe xmlns:vendor="urn:vendor" name="wrong"/><Pipe name="P-0" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="0.5"/></Pipe>{valid_pipe}"#
        ),
    );
    let limits = LandXmlLimits {
        max_pipes: 1,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_pipe_networks_with_cancel(xml.as_bytes(), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    let cancelled = LandXmlCancellationFlag::new();
    cancelled.cancel();
    assert_eq!(
        parse_landxml_pipe_networks_with_cancel(
            xml.as_bytes(),
            &LandXmlLimits::default(),
            Some(&cancelled)
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::Cancelled
    );
}

#[test]
fn issue_5047_uses_schema_default_meter_elevations_and_deferred_root_units() {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 4</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>0 1 5</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="12"/><PipeFlow flowIn="2"/></Pipe></Pipes></PipeNetwork></PipeNetworks><Units><Imperial linearUnit="foot" diameterUnit="inch" flowUnit="cubicFootPerSecond"/></Units></LandXML>"#
    );
    let parsed = parse_landxml_pipe_networks(xml.as_bytes()).expect("schema-valid pipe source");
    let network = &parsed.networks[0];
    assert_eq!(
        network
            .structure_units
            .as_ref()
            .expect("units")
            .elevation_unit,
        "meter"
    );
    assert_eq!(
        network.structures[0]
            .center
            .elevation
            .as_ref()
            .expect("elevation")
            .meters,
        4.0
    );
    assert_eq!(
        network.pipes[0]
            .flow
            .as_ref()
            .and_then(|flow| flow.unit.as_deref()),
        Some("cubicFootPerSecond")
    );
}

#[test]
fn issue_5047_refuses_conflicting_geometry_and_endpoint_inverts_but_allows_both() {
    let invalid = document(
        r#"<Metric linearUnit="meter"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="1"/><RectPipe width="1" height="1"/></Pipe>"#,
    );
    let parsed = parse_landxml_pipe_networks(invalid.as_bytes()).expect("recoverable refusal");
    assert!(parsed.networks[0].pipes.is_empty());
    assert!(parsed
        .refusals
        .iter()
        .any(|item| item.message.contains("conflicting pipe")));

    let both = document(
        r#"<Metric linearUnit="meter"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="1"/></Pipe>"#,
    )
    .replace("flowDir=\"out\"", "flowDir=\"both\"");
    let parsed = parse_landxml_pipe_networks(both.as_bytes()).expect("schema enum both");
    assert_eq!(
        parsed.networks[0].structures[0].inverts[0].flow_direction,
        "both"
    );

    let mismatched = document(
        r#"<Metric linearUnit="meter"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="1"/></Pipe>"#,
    )
    .replace("flowDir=\"out\"", "flowDir=\"in\"");
    let parsed = parse_landxml_pipe_networks(mismatched.as_bytes()).expect("recoverable refusal");
    assert!(parsed.networks[0].structures[0].inverts.is_empty());
    assert!(parsed
        .refusals
        .iter()
        .any(|item| item.message.contains("pipe endpoint")));
}

#[test]
fn issue_5047_enforces_final_reference_budget_and_root_shape() {
    let source = document(
        r#"<Metric linearUnit="meter"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="1"/></Pipe>"#,
    );
    let limits = LandXmlLimits {
        max_references: 0,
        ..LandXmlLimits::default()
    };
    assert_eq!(
        parse_landxml_pipe_networks_with_cancel(source.as_bytes(), &limits, None)
            .expect_err("references are checked while finalizing")
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    for source in [
        b"\n <LandXML xmlns=\"http://www.landxml.org/schema/LandXML-1.2\" version=\"1.2\"/>junk".as_slice(),
        b"<LandXML xmlns=\"http://www.landxml.org/schema/LandXML-1.2\" version=\"1.2\"/><LandXML xmlns=\"http://www.landxml.org/schema/LandXML-1.2\" version=\"1.2\"/>".as_slice(),
    ] {
        assert_eq!(
            parse_landxml_pipe_networks(source).expect_err("one root without junk").code,
            LandXmlDiagnosticCode::InvalidXml
        );
    }
}

#[test]
fn issue_5047_refuses_nested_center_text_empty_flows_and_nonfinite_scaled_measures() {
    let nested_center = document(
        r#"<Metric linearUnit="meter"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="1"/><Center><Nested>4 5</Nested></Center></Pipe>"#,
    );
    assert_eq!(
        parse_landxml_pipe_networks(nested_center.as_bytes())
            .expect_err("Center text must be direct")
            .code,
        LandXmlDiagnosticCode::InvalidSemantic
    );
    let empty_flow = document(
        r#"<Metric linearUnit="meter"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2"><CircPipe diameter="1"/><PipeFlow/></Pipe>"#,
    );
    let parsed = parse_landxml_pipe_networks(empty_flow.as_bytes()).expect("flow refusal is local");
    assert!(parsed.networks[0].pipes[0].flow.is_none());
    assert!(parsed
        .refusals
        .iter()
        .any(|item| item.message.contains("flow record is missing")));
    let scaled_overflow = document(
        r#"<Metric linearUnit="kilometer"/>"#,
        r#"<Pipe name="P-1" refStart="MH-1" refEnd="MH-2" length="1e308"><CircPipe diameter="1"/></Pipe>"#,
    );
    let parsed =
        parse_landxml_pipe_networks(scaled_overflow.as_bytes()).expect("measure refusal is local");
    assert!(parsed.networks[0].pipes.is_empty());
    assert!(parsed
        .refusals
        .iter()
        .any(|item| item.message.contains("scaled measurement")));
}
