// SPDX-License-Identifier: MPL-2.0
use crate::step::{export_step_with_diagnostics, export_step_with_stats, StepOptions};

// Each action's IfcShapeAspect names the action's own IfcProductDefinitionShape, as in
// structural/ifc_structuralanalysisview/steel-joint-modelled-with-shellelements--Axis-Struc.ifc.
const SHARED: &str = "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCVERTEXPOINT(#3);
#6=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#7=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#8=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#9=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#11=IFCSHAPEASPECT((#7,#8),$,$,.U.,#10);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#13=IFCSHAPEASPECT((#7,#8,#9),$,$,.U.,#12);
#20=IFCSTRUCTURALLOADLINEARFORCE('start',0.,0.,-5.,0.,0.,0.);
#21=IFCSTRUCTURALLOADLINEARFORCE('end',0.,0.,-9.,0.,0.,0.);
#22=IFCSTRUCTURALLOADPLANARFORCE('a',0.,0.,-1.);
#23=IFCSTRUCTURALLOADPLANARFORCE('b',0.,0.,-2.);
#24=IFCSTRUCTURALLOADPLANARFORCE('c',0.,0.,-3.);";
const LINE: &str = "#30=IFCSTRUCTURALLINEARACTIONVARYING('3AqvQc$eTFwQAT_AXxIZSF',$,'Line',$,$,$,#10,#20,.GLOBAL_COORDS.,.F.,$,.PROJECTED_LENGTH.,#11,(#21));";
const AREA: &str = "#31=IFCSTRUCTURALPLANARACTIONVARYING('1uiQrU6X9TmxEpF_G_jsDX',$,'Area',$,$,$,#12,#22,.GLOBAL_COORDS.,.T.,$,.TRUE_LENGTH.,#13,(#23,#24));";

fn model(schema: &str, data: &str) -> String {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{SHARED}\n{data}\nENDSEC;END-ISO-10303-21;")
}
fn to(schema: &str) -> StepOptions { StepOptions { schema: Some(schema.into()), ..StepOptions::default() } }
fn record(out: &str, id: &str) -> String { out.lines().find(|l| l.starts_with(id)).unwrap_or_default().to_string() }
fn configs(out: &str) -> Vec<&str> { out.lines().filter(|l| l.contains("=IFCSTRUCTURALLOADCONFIGURATION(")).collect() }

#[test]
fn shared_configuration_linear_and_sinus_is_refused_a() {
    let source = model("IFC4", "#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);\n#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#25,.GLOBAL_COORDS.,.F.,$,.LINEAR.);\n#31=IFCSTRUCTURALCURVEACTION('1d2HL$ILbNDhwyUI0qw12$',$,'Sinus',$,$,$,#10,#25,.GLOBAL_COORDS.,.F.,$,.SINUS.);");
    let result = export_step_with_stats(source.as_bytes(), &to("IFC2X3"));
    assert!(result.err().unwrap().to_string().contains("IFCSTRUCTURALLOADCONFIGURATION"));
}

#[test]
fn aspect_representation_count_matches_loads_b() {
    let source = model("IFC2X3", &format!("{LINE}\n{AREA}"));
    let (ifc4, _) = export_step_with_stats(source.as_bytes(), &to("IFC4")).unwrap();
    for (old, new, id) in [
        ("(#7,#8)", "(#7)", "#30="), ("(#7,#8)", "(#7,#8,#9)", "#30="),
        ("(#7,#8,#9)", "(#7,#8)", "#31="), ("(#7,#8,#9)", "(#7,#8,#9,#6)", "#31="),
    ] {
        let change = |s: &str| s.replace(&format!("IFCSHAPEASPECT({old},"), &format!("IFCSHAPEASPECT({new},"));
        let (out, _) = export_step_with_stats(change(&source).as_bytes(), &to("IFC4")).unwrap();
        // No configuration holds the locations: the constant action (#11354).
        let (target, source_record) = if id == "#30=" { ("IFCSTRUCTURALCURVEACTION(", LINE) } else { ("IFCSTRUCTURALSURFACEACTION(", AREA) };
        assert!(record(&out, id).starts_with(&format!("{id}{target}")) && record(&out, id).ends_with(".CONST.);"), "{out}");
        assert!(!out.contains(source_record), "{out}");
        assert!(export_step_with_stats(change(&ifc4).as_bytes(), &to("IFC2X3")).is_err());
    }
}

/// #11354: comments around the references a configuration needs do not send a complete action to the lossy
/// constant fallback, which reads AppliedLoad comment-aware too.
#[test]
fn commented_load_references_still_convert_to_a_configuration() {
    let line = LINE.replace(",#10,#20,", ",/* rep */#10,/* initial */#20,").replace(",#11,(#21));", ",/* at */#11,(/* next */#21));");
    let (out, _) = export_step_with_stats(model("IFC2X3", &line).as_bytes(), &to("IFC4")).unwrap();
    assert!(record(&out, "#30=").starts_with("#30=IFCSTRUCTURALCURVEACTION(") && record(&out, "#30=").ends_with(".NOTDEFINED.);"), "{out}");
    assert_eq!(configs(&out), ["#31=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);"], "{out}");
}

#[test]
fn varying_actions_round_trip_through_ifc4_9668() {
    let source = model("IFC2X3", &format!("{LINE}\n{AREA}"));
    let (ifc4, _, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC4")).unwrap();
    // The ids after the source's highest, #31, in source order.
    assert_eq!(record(&ifc4, "#30="), "#30=IFCSTRUCTURALCURVEACTION('3AqvQc$eTFwQAT_AXxIZSF',$,'Line',$,$,$,#10,#32,.GLOBAL_COORDS.,.F.,.PROJECTED_LENGTH.,.NOTDEFINED.);");
    assert_eq!(record(&ifc4, "#31="), "#31=IFCSTRUCTURALSURFACEACTION('1uiQrU6X9TmxEpF_G_jsDX',$,'Area',$,$,$,#12,#33,.GLOBAL_COORDS.,.T.,.TRUE_LENGTH.,.NOTDEFINED.);");
    assert_eq!(configs(&ifc4), ["#32=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);", "#33=IFCSTRUCTURALLOADCONFIGURATION($,(#22,#23,#24),$);"]);
    assert!(warnings.iter().any(|w| w.starts_with("2 structural conversion record(s): an IFC2X3 varying action is written")), "{warnings:?}");
    let log = crate::step_log::MutationLog::from_json("{}").unwrap();
    let (logged, _) = crate::step_log::export_step_with_log(source.as_bytes(), &to("IFC4"), &log).unwrap();
    assert_eq!(configs(&logged), configs(&ifc4));

    let (back, _, warnings) = export_step_with_diagnostics(ifc4.as_bytes(), &to("IFC2X3")).unwrap();
    assert_eq!(record(&back, "#30="), LINE);
    assert_eq!(record(&back, "#31="), AREA);
    assert!(configs(&back).is_empty(), "{back}");
    assert!(warnings.iter().any(|w| w.starts_with("2 structural conversion record(s): an IFC4 curve or surface action")), "{warnings:?}");
    let (logged, _) = crate::step_log::export_step_with_log(ifc4.as_bytes(), &to("IFC2X3"), &log).unwrap();
    assert_eq!((record(&logged, "#30="), record(&logged, "#31="), configs(&logged).len()), (LINE.to_string(), AREA.to_string(), 0));
}

#[test]
fn caused_by_is_written_as_causes_9668() {
    // #10597: the 'Causes' carrier holds a converted varying action's CausedBy, as in the TypeScript twin.
    let line = LINE.replace(",.F.,$,", ",.F.,#40,");
    let source = model("IFC2X3", &format!("#40=IFCSTRUCTURALPOINTREACTION('2wmGMbnLPTYekiqaYJVorK',$,$,$,$,$,$,#20,.GLOBAL_COORDS.);\n{line}"));
    let (out, _, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC4")).unwrap();
    assert!(out.lines().any(|l| l.ends_with("'Causes',$,(#40),$,#30);")), "{out}");
    assert!(warnings.iter().any(|w| w.contains("IFC2X3 CausedBy is written as an IfcRelAssignsToProduct named 'Causes'")), "{warnings:?}");
    assert!(!warnings.iter().any(|w| w.contains("CausedBy has no slot")), "{warnings:?}");
}

#[test]
fn a_subset_with_all_load_locations_converts_the_varying_action_11037() {
    let source = model("IFC2X3", LINE);
    let (out, _) = export_step_with_stats(source.as_bytes(), &StepOptions { included: Some(vec![1, 10, 11, 20, 21, 30]), ..to("IFC4") }).unwrap();
    assert!(record(&out, "#30=").starts_with("#30=IFCSTRUCTURALCURVEACTION("), "{out}");
    assert_eq!(configs(&out), ["#31=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);"]);
}

#[test]
fn unknown_destabilizing_load_is_reported_and_mixed_loads_refused_9668() {
    // ProjectedOrTrue has no IFC2X3 default, so it stays `$` and the slot fill reports it.
    let line = "#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#25,.GLOBAL_COORDS.,$,$,.LINEAR.);";
    let source = model("IFC4", &format!("#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);\n{line}"));
    let (out, _, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC2X3")).unwrap();
    assert_eq!(record(&out, "#30="), "#30=IFCSTRUCTURALLINEARACTIONVARYING('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#20,.GLOBAL_COORDS.,.F.,$,$,#11,(#21));");
    assert!(warnings.iter().any(|w| w.contains("IFCSTRUCTURALCURVEACTION.DestabilizingLoad is unknown")), "{warnings:?}");
    // A planar load among the values: not a varying linear action, so the configuration stays and has no IFC2X3 form.
    let mixed = source.replace("(#20,#21)", "(#20,#22)");
    assert!(export_step_with_stats(mixed.as_bytes(), &to("IFC2X3")).is_err());
}

#[test]
fn reports_a_commented_unset_destabilizing_load_on_a_varying_action_11001() {
    let line = "#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#25,.GLOBAL_COORDS.,/* unknown */$,$,.LINEAR.);";
    let source = model("IFC4", &format!("#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);\n{line}"));
    let (out, _, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC2X3")).unwrap();
    assert!(record(&out, "#30=").starts_with("#30=IFCSTRUCTURALLINEARACTIONVARYING("), "{out}");
    assert!(warnings.iter().any(|w| w.contains("IFCSTRUCTURALCURVEACTION.DestabilizingLoad is unknown")), "{warnings:?}");
}

#[test]
fn converts_only_what_converts_back_9668() {
    // A varying action no configuration can hold is written constant (#11354).
    // #13 places #12, not #10, so a downgrade could not find #30's locations again.
    let source = model("IFC2X3", &format!("{}\n{AREA}", LINE.replace(",#11,(#21));", ",#13,(#21));")));
    let (out, _) = export_step_with_stats(source.as_bytes(), &to("IFC4")).unwrap();
    assert!(record(&out, "#30=").starts_with("#30=IFCSTRUCTURALCURVEACTION(") && record(&out, "#30=").ends_with(".CONST.);"), "{out}");
    assert_eq!(configs(&out), ["#32=IFCSTRUCTURALLOADCONFIGURATION($,(#22,#23,#24),$);"]);
}

#[test]
fn a_configuration_named_outside_applied_load_is_kept_9668() {
    // An illegal ObjectPlacement naming the configuration: dropping it would leave #30 dangling.
    let (ifc4, _) = export_step_with_stats(model("IFC2X3", LINE).as_bytes(), &to("IFC4")).unwrap();
    assert!(ifc4.contains("'Line',$,$,$,#10,#31,"), "{ifc4}");
    let ifc4 = ifc4.replace("'Line',$,$,$,#10,#31,", "'Line',$,$,#31,#10,#31,");
    let result = export_step_with_stats(ifc4.as_bytes(), &to("IFC2X3"));
    assert!(result.as_ref().map_or(true, |(out, _)| !record(out, "#30=").starts_with("#30=IFCSTRUCTURALLINEARACTIONVARYING(")));
    assert!(result.is_err(), "the kept configuration has no IFC2X3 form");
}

#[test]
fn a_configuration_another_record_names_is_kept_9668() {
    // #40's illegal ObjectPlacement names #25: dropping #25 would leave #40 dangling.
    let source = model("IFC4", "#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);\n#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#25,.GLOBAL_COORDS.,.F.,$,.LINEAR.);\n#40=IFCBUILDINGELEMENTPROXY('2O2Fr$t4X7Zf8NOew3FLOH',$,$,$,$,#25,$,$,$);");
    assert!(export_step_with_stats(source.as_bytes(), &to("IFC2X3")).is_err(), "the kept configuration has no IFC2X3 form");
    // A distribution that is not linear between the values is not a varying action either.
    assert!(export_step_with_stats(source.replace(",#25,$,$,$);", ",$,$,$,$);").replace(".LINEAR.", ".SINUS.").as_bytes(), &to("IFC2X3")).is_err());
}

#[test]
fn an_ifc4_action_without_its_shape_aspect_is_not_rewritten_9668() {
    // No IfcShapeAspect names the action's representation, so IFC2X3 has no
    // location for the values: the configuration still has no IFC2X3 form.
    let source = model("IFC4", "#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),((0.),(4.)));\n#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,$,#25,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.LINEAR.);");
    assert!(export_step_with_stats(source.as_bytes(), &to("IFC2X3")).is_err());
}
