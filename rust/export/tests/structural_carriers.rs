// SPDX-License-Identifier: MPL-2.0
use ifc_lite_export::{export_step_with_log, export_step_with_stats, MutationLog, StepOptions};

fn source(schema: &str, data: &str) -> String {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{data}\nENDSEC;END-ISO-10303-21;")
}

fn plain(file: &str, schema: &str) -> String {
    export_step_with_stats(file.as_bytes(), &StepOptions { schema: Some(schema.into()), ..StepOptions::default() }).unwrap().0
}

fn logged(file: &str, schema: &str) -> String {
    let log = MutationLog::from_json("{}").unwrap();
    export_step_with_log(file.as_bytes(), &StepOptions { schema: Some(schema.into()), ..StepOptions::default() }, &log).unwrap().0
}

#[test]
fn loads_round_trip_with_coefficients_and_no_carrier_residue_9668() {
    let original = source("IFC4", "#20=IFCSTRUCTURALLOADCASE('1gUSy$VNbHyPCNtxi3Mz27',$,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S',(0.,0.,-1.));");
    for downgraded in [plain(&original, "IFC2X3"), logged(&original, "IFC2X3")] {
        assert!(downgraded.contains("#20=IFCSTRUCTURALLOADGROUP("), "{downgraded}");
        assert!(downgraded.contains("IFCPROPERTYLISTVALUE('SelfWeightCoefficients',$,(IFCRATIOMEASURE(0.),IFCRATIOMEASURE(0.),IFCRATIOMEASURE(-1.)),$)"));
        for upgraded in [plain(&downgraded, "IFC4"), logged(&downgraded, "IFC4")] {
            assert!(upgraded.contains("#20=IFCSTRUCTURALLOADCASE('1gUSy$VNbHyPCNtxi3Mz27',$,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S',(0.,0.,-1.));"), "{upgraded}");
            assert!(!upgraded.contains("'IFC4 IfcStructuralLoadCase'"), "{upgraded}");
        }
    }
    let owner = original.replace("#20=IFCSTRUCTURAL", concat!(
        "#1=IFCPERSON($,'P',$,$,$,$,$,$);\n",
        "#2=IFCORGANIZATION($,'O',$,$,$);\n",
        "#3=IFCPERSONANDORGANIZATION(#1,#2,$);\n",
        "#4=IFCAPPLICATION(#2,'1','A','A');\n",
        "#5=IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,1);\n",
        "#20=IFCSTRUCTURAL",
    ));
    for downgraded in [plain(&owner, "IFC2X3"), logged(&owner, "IFC2X3")] {
        assert!(downgraded.contains(",#5,'IFC4 IfcStructuralLoadCase',$,(#21));"), "{downgraded}");
        assert!(downgraded.contains(",#5,$,$,(#20),#22);"), "{downgraded}");
    }
    let malformed = original.replace("(0.,0.,-1.)", "(0.,-1.)");
    assert!(!plain(&malformed, "IFC2X3").contains("'SelfWeightCoefficients'"));
}

#[test]
fn varying_thickness_round_trips_when_the_shape_aspect_identifies_points_9668() {
    let original = source("IFC2X3", concat!(
        "#7=IFCCARTESIANPOINT((0.,0.,0.));\n",
        "#8=IFCAXIS2PLACEMENT3D(#7,$,$);\n",
        "#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);\n",
        "#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));\n",
        "#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));\n",
        "#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));\n",
        "#17=IFCSHAPEASPECT((#16),'Thickness locations',$,.T.,#15);\n",
        "#20=IFCSTRUCTURALSURFACEMEMBERVARYING('2KZvpy1jjNYvbqlQZoD987',$,'Slab',$,$,$,#15,.SHELL.,0.2,(0.25,0.3),#17);",
    ));
    for upgraded in [plain(&original, "IFC4"), logged(&original, "IFC4")] {
        assert!(upgraded.contains("'Thickness3',$,IFCPOSITIVELENGTHMEASURE(0.3),$"), "{upgraded}");
        for downgraded in [plain(&upgraded, "IFC2X3"), logged(&upgraded, "IFC2X3")] {
            assert!(downgraded.contains(",#15,.SHELL.,0.2,(0.25,0.3),#17);"), "{downgraded}");
        }
    }
    let not_points = original.replace("'Reference','Point',(#7)", "'Reference','Point',(#8)");
    assert!(!plain(&not_points, "IFC4").contains("'Thickness3'"));
}

#[test]
fn equally_placed_structural_items_share_the_lowest_placement_in_ifc4_9668() {
    let original = source("IFC2X3", concat!(
        "#7=IFCCARTESIANPOINT((0.,0.,0.));\n",
        "#8=IFCAXIS2PLACEMENT3D(#7,$,$);\n",
        "#9=IFCLOCALPLACEMENT($,#8);\n",
        "#10=IFCLOCALPLACEMENT($,#8);\n",
        "#20=IFCSTRUCTURALPOINTCONNECTION('0XciGbSFPUkgAKmWK4M6tc',$,'A',$,$,#9,$,$);\n",
        "#21=IFCSTRUCTURALPOINTCONNECTION('1IIB7Cy$HI3REa9CT8boqX',$,'B',$,$,#10,$,$);\n",
        "#30=IFCSTRUCTURALANALYSISMODEL('3rBQGmCZHSd9Yn0gS5NyiS',$,'Model',$,$,.LOADING_3D.,$,$,$);\n",
        "#31=IFCRELASSIGNSTOGROUP('1rjQw6HYfMHPFWRTOSlRaA',$,$,$,(#20,#21),$,#30);",
    ));
    for upgraded in [plain(&original, "IFC4"), logged(&original, "IFC4")] {
        assert!(upgraded.contains("'Model',$,$,.LOADING_3D.,$,$,$,#9);"), "{upgraded}");
        assert!(upgraded.contains("'B',$,$,#9,$,$"), "{upgraded}");
    }
    let different = original.replace("#10=IFCLOCALPLACEMENT($,#8)", "#10=IFCLOCALPLACEMENT(#9,#8)");
    assert!(!plain(&different, "IFC4").contains("'Model',$,$,.LOADING_3D.,$,$,$,#9);"));
}

const SOURCE: &[u8] = b"ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;\n#50=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#1,$,$,$,$,$,.RIGID_JOINED_MEMBER.);\n#80=IFCDIRECTION((0.,1.,0.));\n#90=IFCRELASSOCIATESPROFILEPROPERTIES('3Npn749xX3h8J7ezZM_AKg',#1,$,$,(#50),#81,$,#80);\nENDSEC;END-ISO-10303-21;";

#[test]
fn resolves_placed_member_axis_from_world_in_both_writers_9668() {
    let source = std::str::from_utf8(SOURCE).unwrap()
        .replace("#1,$,$,$,$,$,.RIGID", "#1,$,$,$,#75,$,.RIGID")
        .replace("#80=IFCDIRECTION", concat!(
            "#70=IFCCARTESIANPOINT((0.,0.,0.));\n",
            "#71=IFCAXIS2PLACEMENT3D(#70,$,#80);\n",
            "#74=IFCLOCALPLACEMENT($,#71);\n",
            "#72=IFCAXIS2PLACEMENT3D(#70,$,$);\n",
            "#75=IFCLOCALPLACEMENT(#74,#72);\n",
            "#80=IFCDIRECTION",
        ));
    let options = StepOptions { schema: Some("IFC4".into()), ..StepOptions::default() };
    let log = MutationLog::from_json("{}").unwrap();
    let (plain, stats) = export_step_with_stats(source.as_bytes(), &options).unwrap();
    let (logged, logged_stats) = export_step_with_log(source.as_bytes(), &options, &log).unwrap();
    for output in [plain, logged] {
        assert!(output.contains(".RIGID_JOINED_MEMBER.,#91)"), "{output}");
        assert!(output.contains("#91=IFCDIRECTION((1.,0.,0.));"), "{output}");
    }
    assert_eq!(stats.ifc4_required_slots_unfilled, 0);
    assert!(!logged_stats.warnings.iter().any(|warning| warning.contains("Axis is required")));

    let cycle = source.replace("#74=IFCLOCALPLACEMENT($,", "#74=IFCLOCALPLACEMENT(#75,");
    let (output, stats) = export_step_with_stats(cycle.as_bytes(), &options).unwrap();
    assert!(!output.contains("#91=IFCDIRECTION"), "{output}");
    assert_eq!(stats.ifc4_required_slots_unfilled, 1);
}

#[test]
fn placed_member_axis_round_trips_through_a_profile_carrier_9668() {
    let source = std::str::from_utf8(SOURCE).unwrap()
        .replace("IFC2X3", "IFC4")
        .replace("#1,$,$,$,$,$,.RIGID_JOINED_MEMBER.", "$,$,$,$,#75,$,.RIGID_JOINED_MEMBER.,#81")
        .replace("#80=IFCDIRECTION", concat!(
            "#70=IFCCARTESIANPOINT((0.,0.,0.));\n",
            "#71=IFCAXIS2PLACEMENT3D(#70,$,#80);\n",
            "#75=IFCLOCALPLACEMENT($,#71);\n",
            "#81=IFCDIRECTION((1.,0.,0.));\n",
            "#80=IFCDIRECTION",
        ))
        .replace("#90=IFCRELASSOCIATESPROFILEPROPERTIES('3Npn749xX3h8J7ezZM_AKg',#1,$,$,(#50),#81,$,#80);\n", "");
    let down = StepOptions { schema: Some("IFC2X3".into()), ..StepOptions::default() };
    let up = StepOptions { schema: Some("IFC4".into()), ..StepOptions::default() };
    let log = MutationLog::from_json("{}").unwrap();
    let (plain, _) = export_step_with_stats(source.as_bytes(), &down).unwrap();
    let (logged, stats) = export_step_with_log(source.as_bytes(), &down, &log).unwrap();
    assert!(!stats.warnings.iter().any(|warning| warning.contains("Axis has no slot")));
    for downgraded in [plain, logged] {
        assert!(downgraded.contains("#82=IFCGENERALPROFILEPROPERTIES($,$,$,$,$,$,$);"), "{downgraded}");
        assert!(downgraded.contains(",$,'IFC4 Axis',$,(#50),#82,$,#84);"), "{downgraded}");
        assert!(downgraded.contains("#84=IFCDIRECTION((0.,1.,0.));"), "{downgraded}");
        let (round_trip, stats) = export_step_with_stats(downgraded.as_bytes(), &up).unwrap();
        assert!(round_trip.contains(".RIGID_JOINED_MEMBER.,#81)"), "{round_trip}");
        assert!(!round_trip.contains("IFC4 Axis"), "{round_trip}");
        assert!(!round_trip.contains("#82=IFCGENERALPROFILEPROPERTIES"), "{round_trip}");
        assert!(!round_trip.contains("#84=IFCDIRECTION"), "{round_trip}");
        assert_eq!(stats.ifc4_required_slots_unfilled, 0);
    }
}
