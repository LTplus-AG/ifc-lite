/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Rights-clear synthetic schema invariants for #5051.

use ifc_lite_landxml::{
    alignment::parse_landxml_alignments_optional, parse_landxml_document,
    parse_landxml_pipe_networks, parse_landxml_plan, parse_landxml_tin,
    LandXmlCapabilityDiagnosticCode, LandXmlDiagnosticCode, LANDXML_10_NAMESPACE,
    LANDXML_11_NAMESPACE, LANDXML_12_NAMESPACE,
};

fn source(namespace: &str, version: &str) -> String {
    source_with_units(namespace, version, "<Metric linearUnit=\"meter\"/>")
}

fn source_with_units(namespace: &str, version: &str, units: &str) -> String {
    format!(
        r#"<LandXML xmlns="{namespace}" version="{version}">
<Units>{units}</Units>
<Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts>
<P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P>
</Pnts><Faces><F>1 2 3</F></Faces><Breaklines><Breakline brkType="standard">
<PntList3D>0 0 0 1 0 0</PntList3D>
</Breakline></Breaklines></Definition><SourceData><DataPoints>
<PntList3D>0 0 0 0 1 0 1 0 0</PntList3D>
</DataPoints><Breaklines><Breakline brkType="standard">
<PntList3D>0 0 0 1 0 0</PntList3D>
</Breakline></Breaklines></SourceData></Surface></Surfaces>
<CgPoints><CgPoint name="control">0 0 0</CgPoint></CgPoints>
<Alignments><Alignment name="route" length="1" staStart="0"><CoordGeom>
<Line><Start>0 0</Start><End>1 0</End></Line>
</CoordGeom><Profile><ProfAlign name="design"><PVI>0 0</PVI><PVI>1 1</PVI>
</ProfAlign></Profile></Alignment></Alignments>
<PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs>
<Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct>
<Struct name="B"><Center>0 1 0</Center><CircStruct diameter="1"/></Struct>
</Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe>
</Pipes></PipeNetwork></PipeNetworks></LandXML>"#
    )
}

#[test]
fn issue_5051_waived_producer_cells_keep_schema_units_and_tin_source_invariants() {
    // These are rights-clear grammar vectors, not Autodesk exports. They are
    // the replacement evidence for the dated Civil 3D corpus waivers in the
    // coverage ledger, so every schema/unit cell must retain source topology
    // and the exact scale consumed by downstream metric adapters.
    for (namespace, version, schema) in [
        (LANDXML_10_NAMESPACE, "1.0", "LandXML-1.0"),
        (LANDXML_11_NAMESPACE, "1.1", "LandXML-1.1"),
        (LANDXML_12_NAMESPACE, "1.2", "LandXML-1.2"),
    ] {
        for (units, token, scale) in [
            ("<Metric linearUnit=\"meter\"/>", "meter", 1.0),
            ("<Imperial linearUnit=\"foot\"/>", "foot", 0.3048),
            (
                "<Imperial linearUnit=\"USSurveyFoot\"/>",
                "USSurveyFoot",
                1200.0 / 3937.0,
            ),
        ] {
            let xml = source_with_units(namespace, version, units);
            let document = parse_landxml_document(xml.as_bytes())
                .expect("rights-clear schema/unit replacement vector must parse");
            let terrain = &document.terrain;
            assert_eq!(terrain.schema, schema);
            assert_eq!(terrain.version, version);
            let declared_units = terrain.units.as_ref().expect("declared units");
            assert_eq!(declared_units.linear_unit, token);
            assert!(
                (declared_units.linear_scale_to_meters - scale).abs() < 1e-12,
                "{schema} {token}: unit scale changed"
            );
            let surface = terrain.surfaces.first().expect("TIN surface");
            assert_eq!(surface.points.len(), 3, "{schema} {token}");
            assert_eq!(
                surface.faces,
                vec![["1".to_owned(), "2".to_owned(), "3".to_owned()]]
            );
            assert_eq!(surface.points[1].northing, 0.0, "{schema} {token}");
            assert_eq!(surface.points[1].easting, 1.0, "{schema} {token}");
            assert_eq!(surface.points[2].northing, 1.0, "{schema} {token}");
            assert_eq!(surface.points[2].easting, 0.0, "{schema} {token}");
            assert_eq!(surface.breaklines.len(), 2, "{schema} {token}");
            assert_eq!(
                surface.breaklines[0].points,
                vec![vec![0.0, 0.0, 0.0], vec![1.0, 0.0, 0.0]]
            );
            assert_eq!(surface.source_data_points.len(), 3, "{schema} {token}");
            assert_eq!(terrain.profiles.len(), 1, "{schema} {token}");
            assert!(terrain.capabilities.renderable_tin, "{schema} {token}");
        }
    }
}

#[test]
fn issue_5051_routes_10_and_11_through_every_bounded_source_family() {
    for (namespace, version, schema) in [
        (LANDXML_10_NAMESPACE, "1.0", "LandXML-1.0"),
        (LANDXML_11_NAMESPACE, "1.1", "LandXML-1.1"),
        (LANDXML_12_NAMESPACE, "1.2", "LandXML-1.2"),
    ] {
        let xml = source(namespace, version);
        let document = parse_landxml_document(xml.as_bytes()).expect("synthetic source document");
        assert_eq!(document.terrain.schema, schema);
        assert_eq!(document.terrain.version, version);
        assert_eq!(document.terrain.surfaces.len(), 1);
        assert_eq!(document.plan.cogo_points().len(), 1);
        assert_eq!(
            document
                .terrain
                .pipe_networks
                .as_ref()
                .expect("pipes")
                .networks
                .len(),
            1
        );
        let pipes = parse_landxml_pipe_networks(xml.as_bytes()).expect("pipes");
        assert_eq!(pipes.schema, schema);
        assert_eq!(pipes.version, version);
        assert!(pipes.capability_diagnostics.is_empty());
        assert_eq!(pipes.networks.len(), 1);
        let plan = parse_landxml_plan(xml.as_bytes()).expect("plan");
        assert_eq!(plan.schema, schema);
        assert_eq!(plan.version, version);
        assert!(plan.capability_diagnostics.is_empty());
        assert_eq!(plan.cogo_points().len(), 1);
        let alignments = parse_landxml_alignments_optional(xml.as_bytes()).expect("alignments");
        assert_eq!(alignments.schema, schema);
        assert_eq!(alignments.version, version);
        assert!(alignments.capability_diagnostics.is_empty());
        assert_eq!(alignments.alignments.len(), 1);
    }
}

#[test]
fn issue_5051_records_known_namespace_version_mismatches_without_rewriting_provenance() {
    for (namespace, declared_version, schema) in [
        (LANDXML_10_NAMESPACE, "1.1", "LandXML-1.0"),
        (LANDXML_11_NAMESPACE, "1.2", "LandXML-1.1"),
        (LANDXML_12_NAMESPACE, "1.0", "LandXML-1.2"),
    ] {
        let xml = source(namespace, declared_version);
        let document =
            parse_landxml_document(xml.as_bytes()).expect("known producer compatibility");
        assert_eq!(document.terrain.schema, schema);
        assert_eq!(document.terrain.version, declared_version);
        assert!(document
            .terrain
            .capability_diagnostics
            .iter()
            .any(|diagnostic| {
                diagnostic.code == LandXmlCapabilityDiagnosticCode::SchemaVersionMismatch
                    && diagnostic.source_id.is_none()
                    && diagnostic.source_path == "LandXML"
            }));
        let plan = parse_landxml_plan(xml.as_bytes()).expect("compatible plan");
        assert_eq!(plan.schema, schema);
        assert_eq!(plan.version, declared_version);
        assert!(plan.capability_diagnostics.iter().any(|diagnostic| {
            diagnostic.code == LandXmlCapabilityDiagnosticCode::SchemaVersionMismatch
                && diagnostic.source_id.is_none()
                && diagnostic.source_path == "LandXML"
        }));
        let pipes = parse_landxml_pipe_networks(xml.as_bytes()).expect("compatible pipes");
        assert_eq!(pipes.schema, schema);
        assert_eq!(pipes.version, declared_version);
        assert!(pipes.capability_diagnostics.iter().any(|diagnostic| {
            diagnostic.code == LandXmlCapabilityDiagnosticCode::SchemaVersionMismatch
                && diagnostic.source_id.is_none()
                && diagnostic.source_path == "LandXML"
        }));
        let alignments =
            parse_landxml_alignments_optional(xml.as_bytes()).expect("compatible alignments");
        assert_eq!(alignments.schema, schema);
        assert_eq!(alignments.version, declared_version);
        assert!(alignments.capability_diagnostics.iter().any(|diagnostic| {
            diagnostic.code == LandXmlCapabilityDiagnosticCode::SchemaVersionMismatch
                && diagnostic.source_id.is_none()
                && diagnostic.source_path == "LandXML"
        }));
    }
}

#[test]
fn issue_5051_refuses_unknown_or_cross_grammar_root_declarations() {
    let unknown_namespace = source("urn:example:landxml", "1.1");
    assert_eq!(
        parse_landxml_tin(unknown_namespace.as_bytes())
            .expect_err("unknown namespace")
            .code,
        LandXmlDiagnosticCode::UnsupportedNamespace
    );
    let unknown_version = source(LANDXML_10_NAMESPACE, "9.9");
    assert_eq!(
        parse_landxml_tin(unknown_version.as_bytes())
            .expect_err("unknown version")
            .code,
        LandXmlDiagnosticCode::UnsupportedVersion
    );
    let mismatched_12 = source(LANDXML_12_NAMESPACE, "9.9");
    assert_eq!(
        parse_landxml_tin(mismatched_12.as_bytes())
            .expect_err("unknown 1.2 version")
            .code,
        LandXmlDiagnosticCode::UnsupportedVersion
    );
    let iso_15143_4 = source("urn:iso:std:iso:15143:-4", "1.0");
    assert_eq!(
        parse_landxml_tin(iso_15143_4.as_bytes())
            .expect_err("ISO 15143-4 is a foreign grammar, not LandXML 1.2")
            .code,
        LandXmlDiagnosticCode::UnsupportedNamespace
    );
}

#[test]
fn issue_5051_does_not_treat_a_child_from_another_grammar_as_root_content() {
    let xml = format!(
        r#"<LandXML xmlns="{LANDXML_11_NAMESPACE}" version="1.1"><Units><Metric linearUnit="meter"/></Units>
<Surfaces xmlns="{LANDXML_12_NAMESPACE}"><Surface name="wrong"><Definition surfType="TIN"><Pnts>
<P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P>
</Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>"#
    );
    let document = parse_landxml_tin(xml.as_bytes()).expect("valid 1.1 root");
    assert!(document.surfaces.is_empty());
}
