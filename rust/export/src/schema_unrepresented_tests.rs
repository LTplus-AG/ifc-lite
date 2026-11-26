// SPDX-License-Identifier: MPL-2.0

use super::*;

fn route(ty: &str, from: &str, to: &str, declared: bool) -> Route {
    missing_type_route(ty, ty, from, to, declared)
}

#[test]
fn ifc2x3_has_no_triangulated_face_set() {
    assert_eq!(route("IFCTRIANGULATEDFACESET", "IFC4", "IFC2X3", true), Route::Unrepresented);
}

#[test]
fn ifc2x3_has_wall() {
    assert_eq!(route("IFCWALL", "IFC4", "IFC2X3", true), Route::Written);
}

#[test]
fn an_ifc4_target_checks_what_an_ifc4x3_or_ifc2x3_source_declares_7742_10902() {
    assert_eq!(route("IFCCURVESEGMENT", "IFC4X3", "IFC4", true), Route::Unrepresented);
    // IFC4X3 drops it, and style flattening carries its styles (D57).
    assert_eq!(route("IFCPRESENTATIONSTYLEASSIGNMENT", "IFC2X3", "IFC4X3", true), Route::Handled);
    // A name the source does not declare is not judged.
    assert_eq!(route("IFCCURVESEGMENT", "IFC4X3", "IFC4", false), Route::Written);
    assert_eq!(route("IFCTRIANGULATEDFACESET", "IFC4X3", "IFC4", true), Route::Written);
    // IFC2X3-only: rooted is proxied, a listed one is kept (D59, #10902), a varying action is the structural pass's (#9668).
    assert_eq!(route("IFCSERVICELIFE", "IFC2X3", "IFC4", true), Route::Unrepresented);
    assert_eq!(route("IFCCALENDARDATE", "IFC2X3", "IFC4", true), Route::Verbatim);
    assert_eq!(route("IFCSTRUCTURALLINEARACTIONVARYING", "IFC2X3", "IFC4", true), Route::Handled);
    // IFC5 has no registry.
    assert_eq!(route("IFCTRIANGULATEDFACESET", "IFC4", "IFC5", true), Route::Written);
}

/// The registry check (#10902), as the TypeScript `schema-representation-registry.test.ts`:
/// every type a source declares and the target lacks, by its route, is the
/// fixture's `routes` partition, so a new source-only type or a fixed gap
/// fails until the fixture says so. Core exposes only the IFC4X3 catalog, so
/// the candidates are it plus every listed name; the TypeScript twin walks
/// each schema's own table and so proves the lists complete.
#[test]
fn every_source_only_type_has_a_route_10902() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/schema_unrepresented_vectors.json")).unwrap();
    let listed = |pair: &str, key: &str| -> Vec<String> {
        let mut v: Vec<String> = fixture["routes"][pair][key].as_array().map_or_else(Vec::new, |a| a.iter().map(|s| s.as_str().unwrap().to_owned()).collect());
        v.sort();
        v
    };
    let mut candidates: std::collections::BTreeSet<String> = ifc_lite_core::IFC_TYPES.iter().map(|t| t.name().to_ascii_uppercase()).collect();
    for routes in fixture["routes"].as_object().unwrap().values() {
        for list in routes.as_object().unwrap().values() {
            candidates.extend(list.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()));
        }
    }
    let schemas = ["IFC2X3", "IFC4", "IFC4X3"];
    for from in schemas {
        for to in schemas.into_iter().filter(|to| *to != from) {
            let (mut verbatim, mut proxied, mut handled, mut omitted) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
            for name in candidates.iter().cloned() {
                if schema_attribute_names(from, &name).is_none() { continue; }
                let new_type = crate::schema_convert::convert_entity_type(&name, from, to);
                if crate::schema_convert::should_skip_entity(&new_type, to) { continue; }
                match missing_type_route(&name, &new_type, from, to, true) {
                    Route::Verbatim => verbatim.push(name),
                    Route::Handled => handled.push(name),
                    Route::Omitted => omitted.push(name),
                    Route::Unrepresented if is_rooted_type(&name) => proxied.push(name),
                    _ => {}
                }
            }
            verbatim.sort();
            proxied.sort();
            handled.sort();
            omitted.sort();
            let pair = format!("{from}>{to}");
            assert_eq!(verbatim, listed(&pair, "verbatim"), "{pair}: written verbatim");
            assert_eq!(handled, listed(&pair, "handled"), "{pair}: another pass's");
            assert_eq!(omitted, listed(&pair, "omitted"), "{pair}: omitted");
            if pair == "IFC2X3>IFC4" {
                assert_eq!(OMIT_ON_UPGRADE, omitted, "OMIT_ON_UPGRADE is sorted and matches the registry");
                assert_eq!(proxied, listed(&pair, "proxied"), "{pair}: proxied");
                let mut ours: Vec<String> = VERBATIM_UPGRADE.iter().map(|s| (*s).to_owned()).collect();
                ours.sort();
                assert_eq!(ours, verbatim, "VERBATIM_UPGRADE is the fixture's list");
            }
        }
    }
}

/// As the TypeScript twin's end-to-end case: an IFC2X3 -> IFC4 upgrade
/// maps, renames, proxies or keeps each record, and the warnings name the
/// proxied and kept ones.
#[test]
fn an_upgrade_writes_each_route_and_names_it_10902() {
    let data = "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);\n#2=IFCSPACE('0AvctVUKr0kugbFTf53O9L',$,'Room',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);\n#3=IFCACTOR('0BvctVUKr0kugbFTf53O9L',$,'Tenant',$,$,$);\n#4=IFCRELOCCUPIESSPACES('0CvctVUKr0kugbFTf53O9L',$,$,$,(#2),$,#3,$);\n#5=IFCMOVE('0DvctVUKr0kugbFTf53O9L',$,'Move',$,$,'T-1','planned',$,.F.,1,$,$,('pack'));\n#6=IFCCALENDARDATE(1,2,2020);\n#7=IFCSERVICELIFE('0EvctVUKr0kugbFTf53O9L',$,'Life',$,$,.ACTUALSERVICELIFE.,10.);";
    let src = format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n{data}\nENDSEC;\nEND-ISO-10303-21;\n");
    let opts = crate::step::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (out, _, warnings) = crate::step::export_step_with_diagnostics(src.as_bytes(), &opts).unwrap();
    let line = |id: &str| out.lines().find(|l| l.starts_with(id)).unwrap_or_default().to_owned();
    assert_eq!(line("#4="), "#4=IFCRELASSIGNSTOACTOR('0CvctVUKr0kugbFTf53O9L',$,$,$,(#2),$,#3,$);");
    assert!(line("#7=") == "#7=IFCPROXY('0EvctVUKr0kugbFTf53O9L',$,'Life',$,$,$,$,.NOTDEFINED.,$);", "{out}");
    assert_eq!(line("#5="), "#5=IFCTASK('0DvctVUKr0kugbFTf53O9L',$,'Move',$,$,'T-1',$,'planned',$,.F.,1,$,$);");
    assert_eq!(line("#6="), "#6=IFCCALENDARDATE(1,2,2020);");
    let named = warnings.join("\n");
    assert!(named.contains("were written as IFCPROXY: IFCSERVICELIFE (1)."), "{named}");
    assert!(named.contains("which readers may reject: IFCCALENDARDATE (1)."), "{named}");
}

/// #11326, twin of the TypeScript loss report: IfcMove and IfcOrderAction attributes with no
/// IfcTask slot count as dropped only when the record populated them.
#[test]
fn an_upgrade_counts_only_populated_move_and_order_action_slots_11326() {
    let dropped = |data: &str| {
        let src = format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n{data}\nENDSEC;\nEND-ISO-10303-21;\n");
        let opts = crate::step::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
        crate::export_step_with_stats(src.as_bytes(), &opts).unwrap().1.attribute_values_dropped
    };
    let head = "'0DvctVUKr0kugbFTf53O9L',$,'M',$,$,'T',$,$,.F.,1";
    assert_eq!(dropped(&format!("#5=IFCMOVE({head},$,$,$);\n#6=IFCORDERACTION({head},$);")), 0);
    assert_eq!(dropped(&format!("#5=IFCMOVE({head},#9,$,$);")), 1);
    assert_eq!(dropped(&format!("#5=IFCMOVE({head},$,#9,('p'));")), 2);
    assert_eq!(dropped(&format!("#6=IFCORDERACTION({head},'A-1');")), 1);
}

#[test]
fn prunes_references_to_removed_ifc2x3_resources_10970() {
    let source = include_bytes!("../tests/fixtures/schema_unrooted_upgrade.ifc");
    let opts = crate::step::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (out, stats, warnings) = crate::step::export_step_with_diagnostics(source, &opts).unwrap();
    let (logged, log_stats) = crate::export_step_with_log(source, &opts, &crate::MutationLog::default()).unwrap();
    let merge_options = crate::MergedOptions { schema: opts.schema.clone(), ..Default::default() };
    let (merged, merged_stats) = crate::export_merged_with_stats(&[source], &merge_options);
    for (output, count, warnings) in [
        (&out, stats.written, &warnings),
        (&logged, log_stats.written, &log_stats.warnings),
        (&merged, merged_stats.written, &merged_stats.warnings),
    ] {
        for dropped in ["#3=", "#6=", "#7=", "#19=", "#21=", "#22="] {
            assert!(!output.lines().any(|line| line.starts_with(dropped)), "{output}");
        }
        assert!(output.contains("#4=IFCGEOMETRICCURVESET((#5));"), "{output}");
        assert!(output.contains("#13=IFCGEOMETRICCURVESET((#5));"), "{output}");
        assert!(output.contains("#12=IFCSTYLEDITEM($,(#11),'keep #3 as text');"), "{output}");
        assert!(output.contains("#17=IFCCURVEBOUNDEDPLANE(#16,#5,());"), "{output}");
        assert!(warnings.iter().any(|warning| warning.contains("#3 (IFCBEZIERCURVE) was omitted")), "{warnings:?}");
        assert!(warnings.iter().any(|warning| warning.contains("#21 (IFCCOMPOSITEPROFILEDEF) was omitted")), "{warnings:?}");
        // Orphaned IfcRelaxation records must be omitted and reported (#11131).
        assert!(warnings.iter().any(|warning| warning.contains("#22 (IFCRELAXATION) was omitted")), "{warnings:?}");
        assert_eq!(count, 16);
    }
}

#[test]
fn clears_an_optional_representation_on_an_unconverted_varying_action_10970() {
    let source = include_bytes!("../tests/fixtures/schema_unrooted_legacy_optional.ifc");
    let opts = crate::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let direct = crate::export_step(source, &opts).unwrap();
    let (logged, _) = crate::export_step_with_log(source, &opts, &crate::MutationLog::default()).unwrap();
    let merged = crate::export_merged(&[source], &crate::MergedOptions { schema: opts.schema, ..Default::default() });
    for (writer, output) in [("direct", direct), ("logged", logged), ("merged", merged)] {
        assert!(output.contains("#30=IFCSTRUCTURALLINEARACTIONVARYING('3sXjCM_kPHN8ZCpuBhV_98',$,'A',$,$,$,$,#11,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,$,$);"), "{writer}: {output}");
        assert!(!output.lines().any(|line| ["#41=", "#42=", "#43="].iter().any(|prefix| line.starts_with(prefix))), "{writer}: {output}");
    }
}

#[test]
fn the_warnings_name_each_type_by_route_10902() {
    let mut plans = crate::schema_plan::PlanCache::default();
    for ty in ["IFCSERVICELIFE", "IFCSERVICELIFE", "IFCCALENDARDATE", "IFCWALL", "IFCSTRUCTURALLINEARACTIONVARYING"] {
        plans.get(ty, "IFC2X3", "IFC4");
    }
    plans.get("IFCCURVESEGMENT", "IFC4X3", "IFC4");
    // An IFC4X3 alignment product is proxied too, on either downgrade.
    plans.get("IFCALIGNMENT", "IFC4X3", "IFC4");
    plans.get("IFCALIGNMENT", "IFC4X3", "IFC2X3");
    // Not the refused IfcCurveSegment, nor the varying action the structural pass names (#9668).
    assert_eq!(plans.warnings(), [
        "4 record(s) of a type the target schema does not declare were written as IFCPROXY: IFCALIGNMENT (2), IFCSERVICELIFE (2).",
        "1 record(s) of a type the target schema does not declare were written as they are, which readers may reject: IFCCALENDARDATE (1).",
    ]);
}

#[test]
fn rooted_unrepresented_type_becomes_a_proxy() {
    // IfcStructuralCurveReaction is an IfcProduct (rooted): IFC2X3 never
    // defined a curve/surface reaction type at all (only
    // IfcStructuralPointReaction), so this is a genuine "no
    // representation" case, not a rename gap. IFCTRIANGULATEDFACESET
    // (used above for `missing_type_route`) is NOT a valid example here
    // -- it's an IfcGeometricRepresentationItem, not an IfcRoot subtype.
    let out =
        resolve_unrepresented_entity("#100=", "IFCSTRUCTURALCURVEREACTION", &[], "IFC2X3", 100)
            .unwrap();
    assert!(out.contains("IFCPROXY"));
    assert!(out.contains("'IFCSTRUCTURALCURVEREACTION'"));
}

#[test]
fn non_rooted_unrepresented_type_errors() {
    // A representation item, not an IfcRoot subtype -- proxying it would
    // swap one illegal file for a differently-illegal one.
    let err = resolve_unrepresented_entity("#101=", "IFCCARTESIANPOINTLIST3D", &[], "IFC2X3", 101)
        .unwrap_err();
    assert_eq!(err.express_id, 101);
    assert!(err.to_string().contains("IFCCARTESIANPOINTLIST3D"));
    assert!(err.to_string().contains("IFC2X3"));
}

#[test]
fn merged_pruning_respects_the_checked_output_id_bound_10970() {
    let first = |id| format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n#{id}=IFCCARTESIANPOINT((0.,0.));\nENDSEC;\nEND-ISO-10303-21;");
    let second = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n\
#1=IFCBEZIERCURVE(1,(#2,#3),.UNSPECIFIED.,.F.,.F.);\n\
#2=IFCCARTESIANPOINT((0.,0.));\n#3=IFCCARTESIANPOINT((1.,1.));\n\
#4=IFCPOLYLINE((#2,#3));\n#5=IFCGEOMETRICCURVESET((#1,#4));\nENDSEC;\nEND-ISO-10303-21;";
    let options = crate::MergedOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (output, stats) = crate::export_merged_with_stats(&[first(u32::MAX - 5).as_bytes(), second], &options);
    assert_eq!(stats.unmerged_model_count, 0);
    assert!(!output.contains("#4294967291="), "{output}");
    assert!(output.contains("#4294967295=IFCGEOMETRICCURVESET((#4294967294));"), "{output}");
    assert!(stats.warnings.iter().any(|warning| warning.contains("#4294967291 (IFCBEZIERCURVE) was omitted")));
    let (output, stats) = crate::export_merged_with_stats(&[first(u32::MAX).as_bytes(), second], &options);
    assert_eq!(stats.unmerged_model_count, 1);
    assert!(!output.contains("IFCGEOMETRICCURVESET"), "{output}");
}

#[test]
fn logged_pruning_keeps_creation_counts_separate_from_source_and_deferred_records_10970() {
    let source = include_str!("../tests/fixtures/schema_unrooted_legacy_optional.ifc")
        .replace("#30=", "#18=IFCSTRUCTURALLOADLINEARFORCE('additional',0.,0.,-6.,0.,0.,0.);\n\
#19=IFCSTRUCTURALLOADLINEARFORCE('additional',0.,0.,-7.,0.,0.,0.);\n\
#16=IFCSHAPEASPECT((#42,#42,#42),$,$,.T.,#43);\n#30=")
        .replace("#11,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,$,$);", "#11,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,#16,(#18,#19));");
    let log = crate::MutationLog::from_json(r#"{"newEntities":[
        {"expressId":44,"type":"IfcRelaxation","attributes":[0.1,0.5]},
        {"expressId":45,"type":"IfcCartesianPoint","attributes":[[2,3]]}
    ]}"#).unwrap();
    let opts = crate::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (output, stats) = crate::export_step_with_log(source.as_bytes(), &opts, &log).unwrap();
    assert!(!output.contains("#44=") && !output.contains("#41="), "{output}");
    assert!(output.contains("#45=IFCCARTESIANPOINT("), "{output}");
    assert!(output.contains("#46=IFCSTRUCTURALLOADCONFIGURATION("), "{output}");
    assert_eq!(stats.new_entities, 2);
    assert!(output.contains("2 modifications"), "{output}");
}

#[test]
fn logged_pruning_settles_header_without_a_deferred_varying_pass_10970() {
    let source = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n#1=IFCCARTESIANPOINT((0.,0.));\nENDSEC;\nEND-ISO-10303-21;";
    let log = crate::MutationLog::default().with_new_entities(vec![
        crate::LogNewEntity::new(2, "IfcRelaxation", vec![serde_json::json!(0.1), serde_json::json!(0.5)]),
    ]);
    let opts = crate::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (output, stats) = crate::export_step_with_log(source, &opts, &log).unwrap();
    assert!(output.contains("#1=IFCCARTESIANPOINT("), "{output}");
    assert!(!output.contains("#2=") && !output.contains("Re-exported by ifc-lite"), "{output}");
    assert_eq!((stats.written, stats.new_entities), (1, 0));
}

#[test]
fn omits_a_sectioned_spine_that_loses_a_section_10970() {
    let source = include_bytes!("../tests/fixtures/schema_unrooted_spine.ifc");
    let opts = crate::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
    let direct = crate::export_step(source, &opts).unwrap();
    let (logged, _) = crate::export_step_with_log(source, &opts, &crate::MutationLog::default()).unwrap();
    let merged = crate::export_merged(&[source], &crate::MergedOptions { schema: opts.schema, ..Default::default() });
    for output in [direct, logged, merged] {
        assert!(!output.contains("#13=") && !output.contains("#16="), "{output}");
        assert!(output.contains("#17=IFCSECTIONEDSPINE(#6,(#12,#15,#14),(#7,#8,#9));"), "{output}");
    }
}

#[test]
fn upgrades_deleted_ifc4_types_to_ifc4x3_10971() {
    let source = include_bytes!("../tests/fixtures/schema_ifc4x3_deleted_types.ifc");
    let opts = crate::StepOptions { schema: Some("IFC4X3".into()), ..Default::default() };
    let (out, stats, _) = crate::export_step_with_diagnostics(source, &opts).unwrap();
    assert_eq!(stats.attribute_values_dropped, 5);
    for line in [
        "#1=IFCDOORTYPE('0YvctVUKr0kugbFTf53O9L',$,'Door Style',$,$,$,$,'D-1',$,.NOTDEFINED.,.SINGLE_SWING_LEFT.,.T.,$);",
        "#2=IFCWINDOWTYPE('0YvctVUKr0kugbFTf53O9A',$,'Window Style',$,$,$,$,'W-1',$,.NOTDEFINED.,.DOUBLE_PANEL_VERTICAL.,.F.,$);",
        "#3=IFCBUILDINGELEMENTPROXY('0YvctVUKr0kugbFTf53O9B',$,'Proxy',$,'Proxy object',$,$,'PX-1',.NOTDEFINED.);",
        "#4=IFCWALL('0YvctVUKr0kugbFTf53O9C',$,'Wall',$,$,$,$,$,.NOTDEFINED.);",
    ] {
        assert!(out.contains(line), "{line}\n{out}");
    }
}

#[test]
fn omits_ifc2x3_resources_and_rewrites_ifc4x3_referrers_10971() {
    let source = include_bytes!("../tests/fixtures/schema_unrooted_upgrade.ifc");
    let opts = crate::StepOptions { schema: Some("IFC4X3".into()), ..Default::default() };
    let out = crate::export_step(source, &opts).unwrap();
    for dropped in ["#3=", "#6=", "#7=", "#19=", "#21="] {
        assert!(!out.lines().any(|line| line.starts_with(dropped)), "{out}");
    }
    assert!(out.contains("#4=IFCGEOMETRICCURVESET((#5));"), "{out}");
    assert!(out.contains("#12=IFCSTYLEDITEM($,(#10),'keep #3 as text');"), "{out}");
}

#[test]
fn clears_only_the_optional_zone_of_a_retained_local_time_in_ifc4x3_10971() {
    // A damaged HourOffset refers to an obsolete curve, so the offset is pruned.
    let source = include_bytes!("../tests/fixtures/schema_ifc4x3_legacy_optional.ifc");
    let opts = crate::StepOptions { schema: Some("IFC4X3".into()), ..Default::default() };
    let (direct, _, direct_warnings) = crate::export_step_with_diagnostics(source, &opts).unwrap();
    let (logged, log_stats) = crate::export_step_with_log(source, &opts, &crate::MutationLog::default()).unwrap();
    let (merged, merged_stats) = crate::export_merged_with_stats(
        &[source], &crate::MergedOptions { schema: opts.schema, ..Default::default() },
    );
    for (writer, output, warnings) in [
        ("direct", direct, direct_warnings),
        ("logged", logged, log_stats.warnings),
        ("merged", merged, merged_stats.warnings),
    ] {
        assert!(output.contains("#5=IFCLOCALTIME(10,30,15.,$,$);"), "{writer}: {output}");
        assert!(output.contains("#7=IFCDATEANDTIME(#6,#5);"), "{writer}: {output}");
        assert!(!output.lines().any(|line| line.starts_with("#3=") || line.starts_with("#4=")), "{writer}: {output}");
        assert!(warnings.iter().any(|w| w.contains("#4 (IFCCOORDINATEDUNIVERSALTIMEOFFSET) was omitted")), "{writer}: {warnings:?}");
        assert!(!warnings.iter().any(|w| w.contains("#5 (IFCLOCALTIME) was omitted")), "{writer}: {warnings:?}");
    }
}
