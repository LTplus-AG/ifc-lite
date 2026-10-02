// SPDX-License-Identifier: MPL-2.0
//! #6587: geometric and logical-placement invariants, not serializer snapshots.

use super::*;
use std::collections::HashSet;
use ifc_lite_processing::{build_geometry_data_export, process_geometry, MeshCoordinateSpace};

fn model(unit: f64, site: bool) -> String {
    let number = |value: f64| writer::real(value / unit).unwrap();
    let parent = if site { "#80" } else { "$" };
    let spatial = if site { "#80=IFCLOCALPLACEMENT($,#11);\n#81=IFCSITE('0M7tQ9Jbj1BAeHd7rqnDmP',$,'Site',$,$,#80,$,$,.ELEMENT.,$,$,$,$,$);" } else { "" };
    format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmQ',$,'Project',$,$,$,$,(#10),#4);\n\
#2=IFCSIUNIT(*,.LENGTHUNIT.,{},.METRE.);\n#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#4=IFCUNITASSIGNMENT((#2));\n\
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);\n\
#11=IFCAXIS2PLACEMENT3D(#12,$,$);\n#12=IFCCARTESIANPOINT((0.,0.,0.));\n\
#20=IFCLOCALPLACEMENT({parent},#21);\n#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);\n\
#22=IFCCARTESIANPOINT(({},{},{}));\n#23=IFCDIRECTION((0.6,0.,0.8));\n#24=IFCDIRECTION((0.,1.,0.));\n\
#30=IFCLOCALPLACEMENT(#20,#31);\n#31=IFCAXIS2PLACEMENT3D(#32,$,$);\n#32=IFCCARTESIANPOINT(({},{},{}));\n\
#41=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,{},{});\n#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,{});\n#43=IFCDIRECTION((0.,0.,1.));\n\
#44=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));\n#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));\n\
#50=IFCWALL('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Edited wall',$,$,#30,#45,$,.NOTDEFINED.);\n\
#60=IFCPROJECTEDCRS('EPSG:32610',$,$,$,$,$,#3);\n\
#61=IFCMAPCONVERSION(#10,#60,500000.,4200000.,5.,0.6,0.8,{});\n\
#70=IFCCOLOURRGB($,1.,0.,0.);\n#71=IFCSURFACESTYLERENDERING(#70,0.,$,$,$,$,$,$,.NOTDEFINED.);\n\
#72=IFCSURFACESTYLE('Red',.BOTH.,(#71));\n#73=IFCSTYLEDITEM(#42,(#72),$);\n{spatial}\n\
ENDSEC;\nEND-ISO-10303-21;\n",
        if unit == 1.0 { "$" } else { ".MILLI." },
        number(100.), number(200.), number(30.), number(4.), number(5.), number(6.),
        number(4.), number(2.), number(3.), writer::real(0.9996 * unit).unwrap())
}

fn apply(source: &str, plan: &MapConversionNormalizationPlan) -> String {
    let patches: HashMap<_, _> = plan.replacements.iter().map(|patch| (patch.express_id, patch.line.as_str())).collect();
    let mut scanner = EntityScanner::new(source);
    let mut entities = Vec::new();
    while let Some((id, _, start, end)) = scanner.next_entity() {
        entities.push(patches.get(&id).copied().unwrap_or(&source[start..end]).to_string());
    }
    entities.extend(plan.new_entities.iter().map(|patch| patch.line.clone()));
    format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n", entities.join("\n"))
}

fn world_mesh(source: &str) -> ifc_lite_processing::GeometryDataExport {
    let result = process_geometry(&source.as_bytes());
    let rotation = (result.mesh_coordinate_space == MeshCoordinateSpace::SiteLocal)
        .then_some(result.site_transform.as_deref()).flatten();
    build_geometry_data_export(&result.meshes, result.metadata.coordinate_info.origin_shift, rotation)
}

#[test]
fn issue_6587_map_similarity_preserves_mesh_style_and_logical_points_in_metre_and_mm_projects() {
    for unit in [1.0, 0.001] { for site in [false, true] {
        let source = model(unit, site);
        let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
        let output = apply(&source, &plan);
        let mut before = EntityDecoder::new(&source);
        let mut after = EntityDecoder::new(&output);
        let router = GeometryRouter::with_scale(unit);
        let old = before.decode_by_id(50).unwrap();
        let new = after.decode_by_id(50).unwrap();
        let mut original = Matrix4::from_column_slice(&router.resolve_scaled_placement_strict(&old, &mut before).unwrap());
        let mut updated = Matrix4::from_column_slice(&router.resolve_scaled_placement_strict(&new, &mut after).unwrap());
        for row in 0..3 { original[(row, 3)] /= unit; updated[(row, 3)] /= unit; }
        let geo = GeoRefExtractor::extract(&mut before, &[(61, IfcType::IfcMapConversion), (60, IfcType::IfcProjectedCRS)]).unwrap().unwrap();
        let affine = Matrix4::from_column_slice(&geo.to_matrix());
        let logical_expected = affine * original;
        for row in 0..3 { assert!((updated[(row, 3)] * unit - logical_expected[(row, 3)]).abs() < 1e-8); }
        let map = after.decode_by_id(61).unwrap();
        assert_eq!(map.get_float(7), Some(unit), "neutral map retains project-to-metre units");
        assert_eq!(map.get_float(2), Some(0.0));
        assert_eq!(map.get_float(5), Some(1.0));
        assert_eq!(after.decode_by_id(50).unwrap().get_string(2), Some("Edited wall"));
        assert_eq!(new.get_ref(6), Some(45), "reuse ProductDefinitionShape ownership");
        let definition = after.decode_by_id(45).unwrap();
        let representation = after.decode_by_id(definition.get_refs(2).unwrap()[0]).unwrap();
        let item = after.decode_by_id(representation.get_refs(3).unwrap()[0]).unwrap();
        let operator = after.decode_by_id(item.get_ref(1).unwrap()).unwrap();
        let scale = operator.get_float(3).unwrap();
        assert!((scale - 0.9996).abs() < 1e-12);
        let mut physical = updated * Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::repeat(scale));
        for row in 0..3 { for col in 0..4 { physical[(row, col)] *= unit; } }
        assert!((physical - logical_expected).amax() < 1e-8, "P_new*S equals authored map affine*P");
        let old_mesh = world_mesh(&source);
        let new_mesh = world_mesh(&output);
        let old_body = &old_mesh.elements[&50];
        let new_body = &new_mesh.elements[&50];
        assert_eq!(old_body.faces.len(), 12);
        assert_eq!(new_body.faces.len(), old_body.faces.len());
        assert_eq!(new_body.color, old_body.color, "nested mapped wrapper preserves authored style");
        assert_eq!(new_body.color, [1., 0., 0., 1.]);
        for vertex in &old_body.vertices {
            let expected = geo.local_to_map(vertex[0] / unit, vertex[1] / unit, vertex[2] / unit);
            let expected = nalgebra::Vector3::new(expected.0, expected.1, expected.2);
            let closest = new_body.vertices.iter().map(|point| (expected - nalgebra::Vector3::from_column_slice(point)).norm()).fold(f64::INFINITY, f64::min);
            assert!(closest < 0.0001, "existing production RTC path: corner distance {closest}");
        }
    } }
}

#[test]
fn issue_6587_neutral_project_conversion_preserves_original_map_offsets_without_geometry_work() {
    let source = model(0.001, false).replace("0.6,0.8,0.0009996", "1.,0.,0.001");
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    assert!(plan.replacements.is_empty());
    assert!(plan.new_entities.is_empty());
}

#[test]
fn issue_6691_zero_angle_roundoff_is_a_source_preserving_noop_not_a_consumer_guard_bypass() {
    let source = model(1., false).replace("ENDSEC;\nEND-ISO",
        "#170=IFCCONNECTIONSURFACEGEOMETRY(#171,$);\n#171=IFCPLANE(#11);\nENDSEC;\nEND-ISO");
    for ordinate in [0.0, 6.12323399573677e-17, -6.12323399573677e-17, f64::EPSILON, -f64::EPSILON] {
        for direction_length in [1.0, 2.0] {
            let rotation = format!("{},{},1.", writer::real(direction_length).unwrap(), writer::real(ordinate * direction_length).unwrap());
            let input = source.replace("0.6,0.8,0.9996", &rotation);
            let plan = plan_map_conversion_normalization(input.as_bytes()).unwrap();
            assert!(plan.warnings.is_empty(), "{rotation}: {:?}", plan.warnings);
            assert!(plan.replacements.is_empty() && plan.new_entities.is_empty(), "authored offsets/ordinate must remain untouched");
        }
    }
    // A one-ULP increase above either boundary must still enter the unchanged
    // semantic preflight, not silence an unsupported connection consumer.
    for operation in [
        format!("1.,{},1.", writer::real(f64::EPSILON.next_up()).unwrap()),
        format!("1.,{},1.", writer::real(-f64::EPSILON.next_up()).unwrap()),
        format!("1.,0.,{}", writer::real(1.0_f64.next_up()).unwrap()),
        format!("1.,0.,{}", writer::real(1.0_f64.next_down()).unwrap()),
        format!("{},0.,1.", writer::real(1.0_f64.next_down()).unwrap()),
        "0.9659258262890683,0.25881904510252074,1.".into(),
    ] {
        let input = source.replace("0.6,0.8,0.9996", &operation);
        let plan = plan_map_conversion_normalization(input.as_bytes()).unwrap();
        assert!(plan.warnings.iter().any(|warning| warning.contains("IfcConnectionSurfaceGeometry")), "{operation}: {:?}", plan.warnings);
        assert!(plan.replacements.is_empty() && plan.new_entities.is_empty());
    }
    let scaled = source.replace("IFCMAPCONVERSION(", "IFCMAPCONVERSIONSCALED(")
        .replace("0.6,0.8,0.9996)", &format!("1.,0.,1.,{},1.,1.)", writer::real(1.0_f64.next_up()).unwrap()));
    let plan = plan_map_conversion_normalization(scaled.as_bytes()).unwrap();
    assert!(plan.warnings.iter().any(|warning| warning.contains("per-axis map factors")));
    assert!(plan.replacements.is_empty() && plan.new_entities.is_empty());
}

#[test]
fn issue_6587_unsupported_coordinate_consumers_and_bad_frames_refuse_atomically() {
    let source = model(1., false);
    let cases = [
        source.replace("IFC4X3_ADD2", "IFC2X3"),
        source.replace("FILE_SCHEMA(('IFC4X3_ADD2'));", ""),
        source.replace("#20=IFCLOCALPLACEMENT($,#21)", "#20=IFCLOCALPLACEMENT(#30,#21)"),
        source.replace("#23=IFCDIRECTION((0.6,0.,0.8))", "#23=IFCDIRECTION((0.,0.,0.))"),
        source.replace("#24=IFCDIRECTION((0.,1.,0.))", "#24=IFCDIRECTION((0.6,0.,0.8))"),
        source.replace("'Body','SweptSolid'", "'Axis','SweptSolid'"),
        source.replace("#12=IFCCARTESIANPOINT((0.,0.,0.))", "#12=IFCCARTESIANPOINT((5.,0.,0.))"),
        source.replace("#50=IFCWALL", "#50=IFCANNOTATION"),
        source.replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)", "#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)"),
        source.replace("0.6,0.8,0.9996", "0.,0.,0.9996"),
        source.replace("0.6,0.8,0.9996", "0.6,0.8,-0.9996"),
        source.replace("500000.,4200000.,5.", "'bad',4200000.,5."),
        source.replace("ENDSEC;\nEND-ISO", "#100=IFCRELVOIDSELEMENT('0M7tQ9Jbj1BAeHd7rqnDmS',$,$,$,#50,#50);\nENDSEC;\nEND-ISO"),
    ];
    for malformed in cases {
        let plan = plan_map_conversion_normalization(malformed.as_bytes()).unwrap();
        assert!(!plan.warnings.is_empty(), "unsupported source was accepted");
        assert!(plan.replacements.is_empty());
        assert!(plan.new_entities.is_empty());
    }
}

#[test]
fn issue_6587_direct_planner_never_authorizes_a_tolerant_target_unit_fallback() {
    let source = model(1., false);
    let cases = [
        source.replace("$,$,$,#3);", "$,$,$,#999);"),
        source.replace("$,$,$,#3);", "$,$,$,#12);"),
        source.replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)", "#3=IFCSIUNIT(*,.LENGTHUNIT.,.BOGUS.,.METRE.)"),
        source.replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)", "#3=IFCSIUNIT(*,.AREAUNIT.,$,.METRE.)"),
        source.replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)", "#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.FOOT.)"),
        source.replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)", "#3=IFCCONVERSIONBASEDUNIT(#12,.LENGTHUNIT.,'METRE',#100);\n#100=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3)"),
    ];
    for invalid in cases {
        let plan = plan_map_conversion_normalization(invalid.as_bytes()).unwrap();
        assert!(!plan.warnings.is_empty(), "bad target unit was assumed to be metre");
        assert!(plan.replacements.is_empty());
        assert!(plan.new_entities.is_empty());
    }
    let inherited = source.replace("$,$,$,#3);", "$,$,$,$);");
    assert!(plan_map_conversion_normalization(inherited.as_bytes()).unwrap().warnings.is_empty());
}

#[test]
fn issue_6587_shared_product_definition_rewrites_once_and_allocated_ids_are_unique() {
    let source = model(1., false).replace("ENDSEC;\nEND-ISO", "#51=IFCWALL('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Second',$,$,#30,#45,$,.NOTDEFINED.);\nENDSEC;\nEND-ISO");
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    assert_eq!(plan.replacements.iter().filter(|patch| patch.express_id == 45).count(), 1);
    assert_eq!(plan.new_entities.iter().map(|patch| patch.express_id).collect::<HashSet<_>>().len(), plan.new_entities.len());
    let output = apply(&source, &plan);
    let mut decoder = EntityDecoder::new(&output);
    let a = decoder.decode_by_id(50).unwrap();
    let b = decoder.decode_by_id(51).unwrap();
    assert_eq!(a.get_ref(6), b.get_ref(6));
    assert_ne!(a.get_ref(5), b.get_ref(5), "logical occurrence placements remain independently owned");
}

#[test]
fn issue_6587_type_maps_require_actual_body_reachability_not_orphan_items() {
    let extra = "#170=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));\n#171=IFCREPRESENTATIONMAP(#11,#170);\n#172=IFCBUILDINGELEMENTPROXYTYPE('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Type',$,$,$,(#171),$,$,.NOTDEFINED.);\n#174=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#12,1.,$);\n";
    let source = model(1., false).replace("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"));
    let orphan = source.replace("ENDSEC;\nEND-ISO", "#173=IFCMAPPEDITEM(#171,#174);\nENDSEC;\nEND-ISO");
    for input in [&source, &orphan] {
        let plan = plan_map_conversion_normalization(input.as_bytes()).unwrap();
        assert!(plan.warnings.iter().any(|warning| warning.contains("uninstantiated geometry")));
        assert!(plan.replacements.is_empty());
        assert!(plan.new_entities.is_empty());
    }
    let used = orphan.replace("'Body','SweptSolid',(#42));\n#45", "'Body','MappedRepresentation',(#173));\n#45");
    let plan = plan_map_conversion_normalization(used.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    assert!(!plan.replacements.is_empty(), "a genuinely used type map remains supported");
    let before = world_mesh(&used);
    let after = world_mesh(&apply(&used, &plan));
    assert_eq!(before.elements[&50].faces.len(), after.elements[&50].faces.len());
    let mut decoder = EntityDecoder::new(&used);
    let geo = GeoRefExtractor::extract(&mut decoder, &[(61, IfcType::IfcMapConversion), (60, IfcType::IfcProjectedCRS)]).unwrap().unwrap();
    for point in &before.elements[&50].vertices {
        let expected = geo.local_to_map(point[0], point[1], point[2]);
        assert!(after.elements[&50].vertices.iter().any(|actual|
            (actual[0] - expected.0).hypot(actual[1] - expected.1).hypot(actual[2] - expected.2) < 0.0001));
    }
    let cycle = used.replace("#170=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42))", "#170=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#173))");
    let refused = plan_map_conversion_normalization(cycle.as_bytes()).unwrap();
    assert!(refused.warnings.iter().any(|warning| warning.contains("cyclic")));
    assert!(refused.replacements.is_empty() && refused.new_entities.is_empty());
    let siblings = used.replace("'MappedRepresentation',(#173))", "'MappedRepresentation',(#173,#176))")
        .replace("#170=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42))", "#170=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#176))")
        .replace("ENDSEC;\nEND-ISO", "#176=IFCMAPPEDITEM(#181,#174);\n#177=IFCMAPPEDITEM(#171,#174);\n#180=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#177));\n#181=IFCREPRESENTATIONMAP(#11,#180);\nENDSEC;\nEND-ISO");
    let refused = plan_map_conversion_normalization(siblings.as_bytes()).unwrap();
    assert!(refused.warnings.iter().any(|warning| warning.contains("cyclic")), "mutually cyclic sibling roots must report refusal");
    assert!(refused.replacements.is_empty() && refused.new_entities.is_empty());
    let roots = HashSet::from([44]);
    let mut decoder = EntityDecoder::new(&used);
    assert!(preflight::body_mapped_sources(&roots, 10, &mut decoder, 1).unwrap_err().contains("reference-work bound"));
    let repeated = used.replace("'MappedRepresentation',(#173))", &format!("'MappedRepresentation',({}))", vec!["#173"; 4_000].join(",")));
    let refused = plan_map_conversion_normalization(repeated.as_bytes()).unwrap();
    assert!(refused.warnings.iter().any(|warning| warning.contains("reference-work bound")));
    assert!(refused.replacements.is_empty() && refused.new_entities.is_empty());
}

fn styled_mapped_chain(depth: usize) -> String {
    let mut extra = String::from("#900=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#12,1.,$);\n\
#240=IFCCARTESIANPOINT((6.,0.,0.));\n#241=IFCAXIS2PLACEMENT3D(#240,$,$);\n\
#242=IFCEXTRUDEDAREASOLID(#41,#241,#43,3.);\n\
#270=IFCCOLOURRGB($,0.,1.,0.);\n#271=IFCSURFACESTYLERENDERING(#270,0.,$,$,$,$,$,$,.NOTDEFINED.);\n\
#272=IFCSURFACESTYLE('Green',.BOTH.,(#271));\n#273=IFCSTYLEDITEM(#242,(#272),$);\n");
    let mut item = 0;
    for level in 0..depth {
        let rep = 1000 + level * 3;
        let items = if level == 0 { "#42,#242".to_string() } else { format!("#{item}") };
        extra.push_str(&format!("#{rep}=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',({items}));\n#{}=IFCREPRESENTATIONMAP(#11,#{rep});\n#{}=IFCMAPPEDITEM(#{},#900);\n", rep + 1, rep + 2, rep + 1));
        item = rep + 2;
    }
    model(1., false).replace("'SweptSolid',(#42));\n#45", &format!("'MappedRepresentation',(#{item}));\n#45"))
        .replace("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"))
}

#[test]
fn issue_6634_added_wrapper_reserves_terminal_leaf_and_preserves_styled_depth_30_geometry() {
    let source = styled_mapped_chain(30);
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply(&source, &plan);
    let colored = |text: &str| {
        let result = process_geometry(&text.as_bytes());
        ifc_lite_processing::build_colored_geometry_data_export(&result.meshes,
            result.metadata.coordinate_info.origin_shift, None)
    };
    let before = colored(&source);
    let after = colored(&output);
    let old = &before.elements[&50];
    let new = &after.elements[&50];
    assert_eq!(old.palette, vec![[1., 0., 0., 1.], [0., 1., 0., 1.]]);
    assert_eq!(new.palette, old.palette);
    assert_eq!(old.geometry.faces.len(), 24);
    assert_eq!(new.geometry.faces.len(), 24);
    for index in [0, 1] {
        assert_eq!(old.face_colors.iter().filter(|&&color| color == index).count(), 12);
        assert_eq!(new.face_colors.iter().filter(|&&color| color == index).count(), 12);
    }
    assert_eq!(new.geometry.name, old.geometry.name);
    assert_eq!(new.geometry.global_id, old.geometry.global_id);
    let mut decoder = EntityDecoder::new(&source);
    let geo = GeoRefExtractor::extract(&mut decoder, &[(61, IfcType::IfcMapConversion), (60, IfcType::IfcProjectedCRS)]).unwrap().unwrap();
    for point in &old.geometry.vertices {
        let expected = geo.local_to_map(point[0], point[1], point[2]);
        assert!(new.geometry.vertices.iter().any(|actual|
            (actual[0] - expected.0).hypot(actual[1] - expected.1).hypot(actual[2] - expected.2) < 0.0001));
    }
    for depth in [31, 32] {
        let refused = plan_map_conversion_normalization(styled_mapped_chain(depth).as_bytes()).unwrap();
        assert!(refused.warnings.iter().any(|warning| warning.contains("normalization wrapper")), "{depth}: {:?}", refused.warnings);
        assert!(refused.replacements.is_empty() && refused.new_entities.is_empty());
    }
    // Reach the same subtree at two depths, in either sibling order. A global
    // visited set must not let the shorter alias hide the longest path.
    for items in ["#1089,#1092", "#1092,#1089"] {
        let aliased = source.replace("'MappedRepresentation',(#1089));\n#45", &format!("'MappedRepresentation',({items}));\n#45"))
            .replace("ENDSEC;\nEND-ISO", "#1090=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#1089));\n#1091=IFCREPRESENTATIONMAP(#11,#1090);\n#1092=IFCMAPPEDITEM(#1091,#900);\nENDSEC;\nEND-ISO");
        let refused = plan_map_conversion_normalization(aliased.as_bytes()).unwrap();
        assert!(refused.warnings.iter().any(|warning| warning.contains("normalization wrapper")));
        assert!(refused.replacements.is_empty() && refused.new_entities.is_empty());
    }
}

#[test]
fn issue_6587_public_bridge_deck_uses_the_same_canonical_normalization() {
    let source = fixture_or_skip!("ifc5/Georeferencing_georeferenced-bridge-deck.ifc");
    let plan = plan_map_conversion_normalization(&source).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    assert!(!plan.replacements.is_empty());
    let output = apply(std::str::from_utf8(&source).unwrap(), &plan);
    let mesh = world_mesh(&output);
    assert_eq!(mesh.elements[&16].faces.len(), 12);
    let (xmin, xmax) = mesh.elements[&16].vertices.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p[0]), hi.max(p[0])));
    // Independent pinned IfcOpenShell public-fixture oracle; root verified
    // the exact algorithm through real Cesium asset5970076 accessor bytes.
    assert!((xmin - 545779.8812945185).abs() < 0.001);
    assert!((xmax - 546005.6070590066).abs() < 0.001);
}
