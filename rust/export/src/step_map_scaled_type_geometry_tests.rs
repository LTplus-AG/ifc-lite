// SPDX-License-Identifier: MPL-2.0
//! Type geometry no product instantiates, on the scaled map path. #6634
//! refused it because, left unscaled, it would be wrong once instantiated.
//! It is now wrapped at type level with the same similarity: an instantiation
//! in the exported file must land where the authored one maps to.
use super::super::rigid_fixture_tests::assert_mapped_surfaces;
use super::super::rigid_tests::with_entities;
use super::{apply, model, world_mesh};
use super::super::*;

/// The scaled wall model plus an `IfcBuildingElementProxyType` #172 whose map
/// #171 (origin #175: tilted, and offset far enough that scaling inside
/// rather than outside it moves points by ~9 mm) holds the wall's extrusion; no
/// product instantiates it. `extra` adds entities.
fn typed_model(extra: &str) -> String {
    with_entities(&model(1., true), &format!("\
#170=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));\n\
#175=IFCAXIS2PLACEMENT3D(#176,#23,#24);\n#176=IFCCARTESIANPOINT((200.,100.,50.));\n\
#171=IFCREPRESENTATIONMAP(#175,#170);\n\
#172=IFCBUILDINGELEMENTPROXYTYPE('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Type',$,$,$,(#171),$,$,.NOTDEFINED.);\n\
#174=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#12,1.,$);{extra}"))
}

/// An occurrence #5000 instantiating type map #171 at `placement`, with an
/// identity target: what a consumer would write to use the type geometry.
fn instance(placement: &str) -> String {
    format!("\
#5000=IFCBUILDINGELEMENTPROXY('0M7tQ9Jbj1BAeHd7rqnDmY',$,'Instance',$,$,{placement},#5003,$,.NOTDEFINED.);\n\
#5001=IFCMAPPEDITEM(#171,#174);\n#5002=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#5001));\n\
#5003=IFCPRODUCTDEFINITIONSHAPE($,$,(#5002));")
}

fn geo(source: &str) -> ifc_lite_core::GeoReference {
    let mut decoder = EntityDecoder::new(source);
    GeoRefExtractor::extract(&mut decoder, &[(61, IfcType::IfcMapConversion), (60, IfcType::IfcProjectedCRS)]).unwrap().unwrap()
}

fn to_map(geo: &ifc_lite_core::GeoReference) -> impl Fn(&[f64; 3]) -> nalgebra::Vector3<f64> + '_ {
    |point| { let p = geo.local_to_map(point[0], point[1], point[2]); nalgebra::Vector3::new(p.0, p.1, p.2) }
}

#[test]
fn issue_7359_uninstantiated_type_map_is_wrapped_at_type_level_with_the_map_scale() {
    for orphan in ["", "\n#173=IFCMAPPEDITEM(#171,#174);"] {
        let source = typed_model(orphan);
        let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
        let output = apply(&source, &plan);
        let mut after = EntityDecoder::new(&output);
        // Same map ID and owner; origin becomes identity; the authored origin
        // and representation move, unchanged, into a scaled inner map.
        let map = after.decode_by_id(171).unwrap();
        let identity = after.decode_by_id(map.get_ref(0).unwrap()).unwrap();
        assert!(identity.get(1).unwrap().is_null() && identity.get(2).unwrap().is_null());
        let origin = after.decode_by_id(identity.get_ref(0).unwrap()).unwrap();
        assert_eq!(origin.get_list(0).unwrap().iter().map(|value| value.as_float().unwrap()).collect::<Vec<_>>(), [0., 0., 0.]);
        let wrapper = after.decode_by_id(map.get_ref(1).unwrap()).unwrap();
        assert_eq!((wrapper.get_ref(0), wrapper.get_string(1), wrapper.get_string(2)), (Some(10), Some("Body"), Some("MappedRepresentation")));
        let item = after.decode_by_id(wrapper.get_refs(3).unwrap()[0]).unwrap();
        let inner = after.decode_by_id(item.get_ref(0).unwrap()).unwrap();
        assert_eq!((inner.get_ref(0), inner.get_ref(1)), (Some(175), Some(170)));
        assert!((after.decode_by_id(item.get_ref(1).unwrap()).unwrap().get_float(3).unwrap() - 0.9996).abs() < 1e-12);
        let mut scanner = EntityScanner::new(&source);
        while let Some((id, _, start, end)) = scanner.next_entity() {
            if [170, 172, 173, 174, 175, 176].contains(&id) {
                assert!(output.contains(&source[start..end]), "authored type record #{id} changed");
            }
        }
    }
}

/// The point of #6634: instantiate the type map in the exported file at the
/// wall's exported (logical) frame. It must land on the authored instance's
/// map coordinates; the same instance of the unwrapped map does not.
#[test]
fn issue_7359_instantiated_wrapped_type_map_lands_on_its_authored_map_coordinates() {
    let source = typed_model("");
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply(&source, &plan);
    let wall_frame = EntityDecoder::new(&output).decode_by_id(50).unwrap().get_ref(5).unwrap();
    let authored = world_mesh(&with_entities(&source, &instance("#30")));
    let exported = world_mesh(&with_entities(&output, &instance(&format!("#{wall_frame}"))));
    assert_eq!(authored.elements[&5000].faces.len(), 12);
    let geo = geo(&source);
    assert_mapped_surfaces("type instance", &authored, &exported, &[5000], to_map(&geo));
    // Control: the map left as authored (the pre-#6634 hazard) is off.
    let wrapped = plan.replacements.iter().find(|patch| patch.express_id == 171).unwrap();
    let unwrapped = output.replace(&wrapped.line, "#171=IFCREPRESENTATIONMAP(#175,#170);");
    let control = world_mesh(&with_entities(&unwrapped, &instance(&format!("#{wall_frame}"))));
    let expected: Vec<_> = authored.elements[&5000].vertices.iter().map(to_map(&geo)).collect();
    let worst = control.elements[&5000].vertices.iter().map(|point| {
        let point = nalgebra::Vector3::from_column_slice(point);
        expected.iter().map(|target| (target - point).norm()).fold(f64::INFINITY, f64::min)
    }).fold(0., f64::max);
    assert!(worst > 0.001, "an unscaled type map would be within {worst} m");
}

#[test]
fn issue_7359_nested_or_surface_bearing_uninstantiated_type_geometry_still_refuses() {
    let nested = typed_model("\n#180=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));\n#181=IFCREPRESENTATIONMAP(#11,#180);\n\
#182=IFCBUILDINGELEMENTPROXYTYPE('0M7tQ9Jbj1BAeHd7rqnDmT',$,'Inner',$,$,$,(#181),$,$,.NOTDEFINED.);\n#183=IFCMAPPEDITEM(#181,#174);")
        .replace("#170=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42))", "#170=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#183))");
    let boxed = typed_model("\n#184=IFCBOUNDINGBOX(#12,1.,1.,1.);")
        .replace("#170=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42))", "#170=IFCSHAPEREPRESENTATION(#10,'Box','BoundingBox',(#184))");
    for (input, report) in [
        (nested, "uninstantiated type map #181 is nested in other uninstantiated type geometry"),
        (boxed, "representation #170 is neither a Body nor curve geometry (IfcBoundingBox #184)"),
    ] {
        let plan = plan_map_conversion_normalization(input.as_bytes()).unwrap();
        assert!(plan.warnings.iter().any(|warning| warning.contains(report)), "{report}: {:?}", plan.warnings);
        assert!(plan.replacements.is_empty() && plan.new_entities.is_empty());
    }
}

/// A type map #171 whose representation #5100 tops a styled mapped chain of
/// `depth` levels (red and green solids at the leaf), instantiated by nothing.
fn deep_type_map(depth: usize) -> String {
    let chain = super::styled_mapped_chain(depth);
    let top = 1000 + (depth - 1) * 3 + 2;
    // Keep the wall plain: only the type map reaches the chain.
    let source = chain.replace(&format!("'MappedRepresentation',(#{top}));\n#45"), "'SweptSolid',(#42));\n#45");
    with_entities(&source, &format!("\
#5100=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#{top}));\n#171=IFCREPRESENTATIONMAP(#11,#5100);\n\
#172=IFCBUILDINGELEMENTPROXYTYPE('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Deep type',$,$,$,(#171),$,$,.NOTDEFINED.);\n\
#174=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#12,1.,$);"))
}

/// The type-level wrapper and a consumer's instance item add two mapped
/// levels, one more than a product wrapper: depth 29 is the last that fits
/// the renderer's limit once instantiated (products: 30), and it keeps both
/// styled solids; depth 30 refuses atomically.
#[test]
fn issue_7359_wrapped_type_map_reserves_the_wrapper_and_instance_levels() {
    let source = deep_type_map(29);
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply(&source, &plan);
    let wall_frame = EntityDecoder::new(&output).decode_by_id(50).unwrap().get_ref(5).unwrap();
    let colored = |text: &str| {
        let result = ifc_lite_processing::process_geometry(&text.as_bytes());
        ifc_lite_processing::build_colored_geometry_data_export(&result.meshes, result.metadata.coordinate_info.origin_shift, None)
    };
    let authored = colored(&with_entities(&source, &instance("#30")));
    let exported = colored(&with_entities(&output, &instance(&format!("#{wall_frame}"))));
    for mesh in [&authored, &exported] {
        let instance = &mesh.elements[&5000];
        assert_eq!(instance.palette, vec![[1., 0., 0., 1.], [0., 1., 0., 1.]]);
        assert_eq!(instance.geometry.faces.len(), 24);
    }
    let refused = plan_map_conversion_normalization(deep_type_map(30).as_bytes()).unwrap();
    assert!(refused.warnings.iter().any(|warning| warning.contains("type map nesting leaves no room for the type-level normalization wrapper and an instance")), "{:?}", refused.warnings);
    assert!(refused.replacements.is_empty() && refused.new_entities.is_empty());
}

/// A curve-only type map (a 2D `FootPrint`) with an `IfcAxis2Placement2D`
/// origin: the authored 2D origin moves into the scaled inner map unchanged.
#[test]
fn issue_7359_curve_only_type_map_with_a_2d_origin_is_wrapped() {
    let source = typed_model("\n#185=IFCCARTESIANPOINT((0.,0.));\n#186=IFCCARTESIANPOINT((3.,0.));\n#187=IFCPOLYLINE((#185,#186));\n\
#188=IFCAXIS2PLACEMENT2D(#189,$);\n#189=IFCCARTESIANPOINT((10.,5.));\n#190=IFCSHAPEREPRESENTATION(#10,'FootPrint','Curve2D',(#187));\n\
#191=IFCREPRESENTATIONMAP(#188,#190);")
        .replace("$,(#171),$,$,.NOTDEFINED.)", "$,(#171,#191),$,$,.NOTDEFINED.)");
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply(&source, &plan);
    let mut after = EntityDecoder::new(&output);
    let map = after.decode_by_id(191).unwrap();
    let wrapper = after.decode_by_id(map.get_ref(1).unwrap()).unwrap();
    assert_eq!((wrapper.get_string(1), wrapper.get_string(2)), (Some("FootPrint"), Some("MappedRepresentation")));
    let item = after.decode_by_id(wrapper.get_refs(3).unwrap()[0]).unwrap();
    let inner = after.decode_by_id(item.get_ref(0).unwrap()).unwrap();
    assert_eq!((inner.get_ref(0), inner.get_ref(1)), (Some(188), Some(190)));
    assert!((after.decode_by_id(item.get_ref(1).unwrap()).unwrap().get_float(3).unwrap() - 0.9996).abs() < 1e-12);
    for record in ["#188=IFCAXIS2PLACEMENT2D(#189,$);", "#190=IFCSHAPEREPRESENTATION(#10,'FootPrint','Curve2D',(#187));"] {
        assert!(output.contains(record), "{record}");
    }
}
