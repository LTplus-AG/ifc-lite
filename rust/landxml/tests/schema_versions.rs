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
    format!(
        r#"<LandXML xmlns="{namespace}" version="{version}">
<Units><Metric linearUnit="meter"/></Units>
<Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts>
<P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P>
</Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces>
<CgPoints><CgPoint name="control">0 0 0</CgPoint></CgPoints>
<Alignments><Alignment name="route" length="1" staStart="0"><CoordGeom>
<Line><Start>0 0</Start><End>1 0</End></Line>
</CoordGeom></Alignment></Alignments>
<PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs>
<Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct>
<Struct name="B"><Center>0 1 0</Center><CircStruct diameter="1"/></Struct>
</Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe>
</Pipes></PipeNetwork></PipeNetworks></LandXML>"#
    )
}

#[test]
fn issue_5051_routes_10_and_11_through_every_bounded_source_family() {
    for (namespace, version, schema) in [
        (LANDXML_10_NAMESPACE, "1.0", "LandXML-1.0"),
        (LANDXML_11_NAMESPACE, "1.1", "LandXML-1.1"),
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
        assert_eq!(
            parse_landxml_pipe_networks(xml.as_bytes())
                .expect("pipes")
                .networks
                .len(),
            1
        );
        assert_eq!(
            parse_landxml_plan(xml.as_bytes())
                .expect("plan")
                .cogo_points()
                .len(),
            1
        );
        assert_eq!(
            parse_landxml_alignments_optional(xml.as_bytes())
                .expect("alignments")
                .alignments
                .len(),
            1
        );
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
