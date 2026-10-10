// SPDX-License-Identifier: MPL-2.0
//! #7359: alignment models on the scaled (mapped-representation) map path.
//! Product placements become fresh roots, so linear chains are resolved once
//! (strictly) and then bypassed; every representation, `Axis` curves
//! included, is carried through the same uniformly scaled mapped wrapper.
use super::rigid_fixture_tests::{apply_preserving_header, assert_mapped_surfaces, assert_physical_surfaces};
use super::rigid_tests::{aligned_entities, with_entities};
use super::tests::{apply, model, world_mesh};
use super::*;

/// Wall #50 gains a 2D `Axis` curve in an `Axis` subcontext; #130 is an
/// alignment event annotation (as ACCA writes them) linearly placed along
/// the alignment with a small `Body` block.
fn scaled_aligned_model(unit: f64, linear_parent: &str) -> String {
    let length = |metres: f64| writer::real(metres / unit).unwrap();
    let source = model(unit, true).replace("IFCPRODUCTDEFINITIONSHAPE($,$,(#44))", "IFCPRODUCTDEFINITIONSHAPE($,$,(#124,#44))");
    let extra = format!("\
#120=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);\n\
#121=IFCCARTESIANPOINT((0.,0.));\n#122=IFCCARTESIANPOINT(({},0.));\n#123=IFCPOLYLINE((#121,#122));\n\
#124=IFCSHAPEREPRESENTATION(#120,'Axis','Curve2D',(#123));\n\
#130=IFCANNOTATION('0M7tQ9Jbj1BAeHd7rqnDmX',$,'Superelevation',$,'SUPERELEVATIONEVENT',#131,#132,.USERDEFINED.);\n\
#131=IFCLINEARPLACEMENT(#100,#108,$);\n#132=IFCPRODUCTDEFINITIONSHAPE($,$,(#133));\n\
#133=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#134));\n\
#134=IFCEXTRUDEDAREASOLID(#135,#11,#43,{});\n#135=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,{},{});",
        length(4.), length(0.5), length(0.2), length(0.2));
    with_entities(&with_entities(&source, &aligned_entities(unit, linear_parent)), &extra)
}

/// Column-major world frame in project units (translation divided by `unit`).
fn frame(router: &GeometryRouter, id: u32, decoder: &mut EntityDecoder, unit: f64) -> Matrix4<f64> {
    let product = decoder.decode_by_id(id).unwrap();
    let mut frame = Matrix4::from_column_slice(&router.resolve_scaled_placement_strict(&product, decoder).unwrap());
    for row in 0..3 { frame[(row, 3)] /= unit; }
    frame
}

/// The single wrapper item a scaled representation carries: (MappedItem, map, scale).
fn wrapper(decoder: &mut EntityDecoder, rep: u32) -> (WrapperParts, f64) {
    let rep = decoder.decode_by_id(rep).unwrap();
    let items = rep.get_refs(3).unwrap();
    assert_eq!(items.len(), 1, "one mapped wrapper item");
    let item = decoder.decode_by_id(items[0]).unwrap();
    assert_eq!(item.ifc_type, IfcType::IfcMappedItem);
    let map = decoder.decode_by_id(item.get_ref(0).unwrap()).unwrap();
    let operator = decoder.decode_by_id(item.get_ref(1).unwrap()).unwrap();
    let parts = WrapperParts {
        context: rep.get_ref(0).unwrap(),
        identifier: rep.get_string(1).unwrap().to_string(),
        kind: rep.get_string(2).unwrap().to_string(),
        source: map.get_ref(1).unwrap(),
    };
    (parts, operator.get_float(3).unwrap())
}

#[derive(Debug, PartialEq)]
struct WrapperParts { context: u32, identifier: String, kind: String, source: u32 }

#[test]
fn issue_7359_scaled_alignment_linear_placements_and_axis_curves_preserve_map_points() {
    for unit in [1.0, 0.001] { for linear_parent in ["#100", "$"] {
        let source = scaled_aligned_model(unit, linear_parent);
        let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
        assert!(plan.warnings.is_empty(), "{unit} {linear_parent}: {:?}", plan.warnings);
        let output = apply(&source, &plan);
        let mut before = EntityDecoder::new(&source);
        let mut after = EntityDecoder::new(&output);
        let router = GeometryRouter::with_scale(unit);
        let geo = GeoRefExtractor::extract(&mut before, &[(61, IfcType::IfcMapConversion), (60, IfcType::IfcProjectedCRS)]).unwrap().unwrap();
        let affine = Matrix4::from_column_slice(&geo.to_matrix());
        // The station is sampled from the curve (4 along, 1 lateral, 0.5 up)
        // whether its linear placement has a parent or not: no identity fallback.
        let station = frame(&router, 110, &mut before, unit);
        let expected = [35. / 125f64.sqrt(), 30. / 125f64.sqrt(), 0.5];
        for axis in 0..3 { assert!((station[(axis, 3)] * unit - expected[axis]).abs() < 1e-9, "{station}"); }
        let alignment_rep = after.decode_by_id(105).unwrap().get_refs(2).unwrap()[0];
        let (alignment_axis, scale) = wrapper(&mut after, alignment_rep);
        assert!((scale - 0.9996).abs() < 1e-12, "{scale}");
        assert_eq!(alignment_axis, WrapperParts { context: 10, identifier: "Axis".into(), kind: "MappedRepresentation".into(), source: 104 });
        let wall_reps = after.decode_by_id(45).unwrap().get_refs(2).unwrap();
        let wall: Vec<_> = wall_reps.iter().map(|id| wrapper(&mut after, *id).0).collect();
        assert_eq!(wall, [
            WrapperParts { context: 120, identifier: "Axis".into(), kind: "MappedRepresentation".into(), source: 124 },
            WrapperParts { context: 10, identifier: "Body".into(), kind: "MappedRepresentation".into(), source: 44 },
        ]);
        for id in [50, 81, 106, 110, 112, 130] {
            let old = frame(&router, id, &mut before, unit);
            let new = frame(&router, id, &mut after, unit);
            let mut physical = new * Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::repeat(scale));
            for row in 0..3 { for col in 0..4 { physical[(row, col)] *= unit; } }
            assert!((physical - affine * old).amax() < 1e-8, "#{id}: P_new*S equals authored map affine*P");
            // Each product owns a fresh root: linear chains are bypassed.
            let placement = after.decode_by_id(id).unwrap().get_ref(5).unwrap();
            let placement = after.decode_by_id(placement).unwrap();
            assert_eq!(placement.ifc_type, IfcType::IfcLocalPlacement, "#{id}");
            assert!(placement.get(0).unwrap().is_null(), "#{id}");
        }
        // The alignment's Axis polyline end, through the written placement
        // and the written wrapper scale, lands on its authored map point.
        let end = nalgebra::Vector4::new(10. / unit, 5. / unit, 0., 1.);
        let old = frame(&router, 106, &mut before, unit) * end;
        let map_point = geo.local_to_map(old[0], old[1], old[2]);
        let new = frame(&router, 106, &mut after, unit) * nalgebra::Vector4::new(end[0] * scale, end[1] * scale, 0., 1.) * unit;
        assert!((new.xyz() - nalgebra::Vector3::new(map_point.0, map_point.1, map_point.2)).norm() < 1e-6, "{new}");
        // Curves, linear placements and annotation geometry keep their records.
        let mut scanner = EntityScanner::new(&source);
        while let Some((id, _, start, end)) = scanner.next_entity() {
            if (101..=135).contains(&id) && ![105, 106, 110, 112, 130, 132].contains(&id) {
                assert!(output.contains(&source[start..end]), "original entity #{id} changed");
            }
        }
        let old_mesh = world_mesh(&source);
        let new_mesh = world_mesh(&output);
        assert_same_meshes_except_alignment_ribbons(&old_mesh, &new_mesh, |point| {
            let p = geo.local_to_map(point[0] / unit, point[1] / unit, point[2] / unit);
            nalgebra::Vector3::new(p.0, p.1, p.2)
        });
        assert!(old_mesh.elements.contains_key(&106), "ifc-lite draws the authored alignment ribbon");
        assert!(old_mesh.elements.contains_key(&130), "the annotation block is rendered");
        assert_mapped_surfaces("synthetic", &old_mesh, &new_mesh, &[50, 130], |point| {
            let p = geo.local_to_map(point[0] / unit, point[1] / unit, point[2] / unit);
            nalgebra::Vector3::new(p.0, p.1, p.2)
        });
    } }
}

#[test]
fn issue_7359_unresolvable_linear_placement_and_foreign_context_still_refuse_atomically() {
    let source = scaled_aligned_model(1., "#100");
    let cases = [
        // No CartesianPosition and a basis "curve" that is a point: rendering
        // would fall back to identity; the writer must refuse instead.
        (source.replace("IFCLENGTHMEASURE(4.),1.,0.5,$,#103)", "IFCLENGTHMEASURE(4.),1.,0.5,$,#12)"), "IfcLinearPlacement #109 cannot be resolved"),
        (source.replace("#120=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$)",
            "#120=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-5,#136,$);\n#136=IFCAXIS2PLACEMENT2D(#121,$)"), "another map context"),
        (with_entities(&source, "#140=IFCGRIDPLACEMENT($,$);"), "IfcGridPlacement"),
        // A curve set is carried only when every member is a curve or point.
        (curve_set(&source, "#123,#138"), "neither a Body nor curve geometry (IfcGeometricCurveSet #137)"),
        (with_entities(&source.replace("'Axis','Curve2D',(#123))", "'Axis','Curve2D',(#123,#138))"), "#138=IFCPLANE(#11);"),
            "neither a Body nor curve geometry (IfcPlane #138)"),
    ];
    for (input, report) in cases {
        let plan = plan_map_conversion_normalization(input.as_bytes()).unwrap();
        assert!(plan.warnings.iter().any(|warning| warning.contains(report)), "{report}: {:?}", plan.warnings);
        assert!(plan.replacements.is_empty() && plan.new_entities.is_empty());
    }
    let carried = plan_map_conversion_normalization(curve_set(&source, "#123,#121").as_bytes()).unwrap();
    assert!(carried.warnings.is_empty(), "{:?}", carried.warnings);
}

/// The wall's `Axis` as an `IfcGeometricCurveSet` #137 of `members`.
fn curve_set(source: &str, members: &str) -> String {
    with_entities(&source.replace("'Axis','Curve2D',(#123))", "'Axis','GeometricCurveSet',(#137))"),
        &format!("#137=IFCGEOMETRICCURVESET(({members}));\n#138=IFCPLANE(#11);"))
}

/// Wrapped curve representations never start rendering, and every rendered
/// product keeps its surface: the same triangles, or for large tessellated
/// surfaces (ACCA's terrain and earthworks) a few sliver triangles that the
/// mesher's degenerate filter resolves differently at scaled coordinates, with
/// the physical area unchanged. The one difference in rendered products:
/// ifc-lite draws an `IfcAlignment` as a ribbon sampled from a curve item
/// directly in its `Axis` representation (`alignment_axis::locate_axis_curve`);
/// behind the scaled wrapper that item is an `IfcMappedItem`, so the ribbon
/// is absent.
fn assert_same_meshes_except_alignment_ribbons(
    before: &ifc_lite_processing::GeometryDataExport,
    after: &ifc_lite_processing::GeometryDataExport,
    expect: impl Fn(&[f64; 3]) -> nalgebra::Vector3<f64>,
) {
    let expected: Vec<_> = before.elements.iter().filter(|(_, mesh)| mesh.ifc_type != "IfcAlignment").map(|(id, _)| *id).collect();
    assert_eq!(after.elements.keys().copied().collect::<Vec<_>>(), expected, "wrapped curve representations must not start rendering");
    let area = |points: &[nalgebra::Vector3<f64>], faces: &[[u32; 3]]| faces.iter().map(|face| {
        (points[face[1] as usize] - points[face[0] as usize]).cross(&(points[face[2] as usize] - points[face[0] as usize])).norm() / 2.
    }).sum::<f64>();
    for id in &expected {
        let (old, new) = (&before.elements[id], &after.elements[id]);
        if old.faces.len() == new.faces.len() { continue; }
        assert!(old.faces.len().abs_diff(new.faces.len()) * 100 <= old.faces.len(), "#{id}: {} -> {} faces", old.faces.len(), new.faces.len());
        let old_area = area(&old.vertices.iter().map(&expect).collect::<Vec<_>>(), &old.faces);
        let new_area = area(&new.vertices.iter().map(|point| nalgebra::Vector3::from_column_slice(point)).collect::<Vec<_>>(), &new.faces);
        assert!((old_area - new_area).abs() <= old_area * 1e-6, "#{id}: physical area {old_area} -> {new_area}");
    }
}

/// Replace one attribute of one entity, keeping every other source byte.
fn with_patch(source: &str, target: u32, slot: usize, value: &str) -> String {
    let mut scanner = EntityScanner::new(source);
    while let Some((id, kind, start, end)) = scanner.next_entity() {
        if id == target {
            let record = Record { id, kind: IfcType::from_str(kind), line: &source[start..end] };
            let patch = writer::replace(&record, &[(slot, value.into())]).unwrap();
            return apply_preserving_header(source, &MapConversionNormalizationPlan { replacements: vec![patch], ..Default::default() });
        }
    }
    panic!("entity #{target} is absent");
}

/// Both fixtures author `Scale` as `$` (1). Derive the UTM case #7359
/// describes by writing the 0.9996 central scale factor into that conversion.
fn with_utm_scale(source: &str) -> String {
    let mut scanner = EntityScanner::new(source);
    let map = std::iter::from_fn(|| scanner.next_entity()).find(|(_, kind, _, _)| *kind == "IFCMAPCONVERSION").expect("fixture has an IfcMapConversion").0;
    with_patch(source, map, 7, "0.9996")
}

/// Full scaled-path acceptance for a real alignment model: `rigid_source` is
/// the file at its authored scale 1, exported at 0.9996. Every product frame,
/// every carried representation, the physical surface of linearly placed
/// parts, and their agreement with the rigid path modulo the map scale.
fn assert_scaled_alignment_export(path: &str, rigid_source: &str, products: usize, linear_products: usize, sampled_types: usize) -> ifc_lite_core::GeoReference {
    let source = with_utm_scale(rigid_source);
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply_preserving_header(&source, &plan);
    let mut before = EntityDecoder::new(&source);
    let mut after = EntityDecoder::new(&output);
    let mut scanner = EntityScanner::new(&source);
    let mut kinds = Vec::new();
    while let Some((id, kind, _, _)) = scanner.next_entity() { kinds.push((id, IfcType::from_str(kind))); }
    let geo = GeoRefExtractor::extract(&mut before, &kinds).unwrap().unwrap();
    assert_eq!(geo.scale, 0.9996);
    let affine = Matrix4::from_column_slice(&geo.to_matrix());
    let router = GeometryRouter::with_scale(1.);
    let mut linear = Vec::new();
    let mut identifiers = BTreeMap::<String, usize>::new();
    let mut count = 0;
    for (id, kind) in &kinds {
        if !kind.is_subtype_of(IfcType::IfcProduct) { continue; }
        count += 1;
        let product = before.decode_by_id(*id).unwrap();
        if product.get_ref(5).is_some_and(|placement| before.decode_by_id(placement).unwrap().ifc_type == IfcType::IfcLinearPlacement) {
            linear.push(*id);
        }
        let old = frame(&router, *id, &mut before, 1.);
        let new = frame(&router, *id, &mut after, 1.);
        let scaled = new * Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::repeat(0.9996));
        assert!((scaled - affine * old).amax() < 1e-7, "world frame for #{id}");
        let Some(shape) = product.get_ref(6) else { continue };
        let originals = before.decode_by_id(shape).unwrap().get_refs(2).unwrap();
        let wrapped = after.decode_by_id(shape).unwrap().get_refs(2).unwrap();
        assert_eq!(originals.len(), wrapped.len(), "#{id}");
        for (source_rep, rep) in originals.iter().zip(&wrapped) {
            let (parts, scale) = wrapper(&mut after, *rep);
            let authored = before.decode_by_id(*source_rep).unwrap();
            assert_eq!(parts.source, *source_rep);
            assert_eq!(parts.context, authored.get_ref(0).unwrap());
            assert_eq!(parts.identifier, authored.get_string(1).unwrap());
            assert!((scale - 0.9996).abs() < 1e-12);
            *identifiers.entry(parts.identifier).or_default() += 1;
        }
    }
    assert_eq!(count, products);
    assert_eq!(linear.len(), linear_products);
    // Counted per product occurrence.
    assert!(identifiers.keys().any(|identifier| identifier == "Axis"), "{identifiers:?}");
    eprintln!("{path}: carried representations per identifier {identifiers:?}");

    let before_mesh = world_mesh(&source);
    let after_mesh = world_mesh(&output);
    assert_same_meshes_except_alignment_ribbons(&before_mesh, &after_mesh, |point| {
        let p = geo.local_to_map(point[0], point[1], point[2]);
        nalgebra::Vector3::new(p.0, p.1, p.2)
    });
    // One linearly placed product per IFC type, bounded in size: the surface
    // oracle is brute force.
    let mut types = std::collections::HashSet::new();
    let sample: Vec<_> = linear.iter().copied()
        .filter(|id| before_mesh.elements.get(id).is_some_and(|mesh| mesh.faces.len() <= 2_000))
        .filter(|id| types.insert(before_mesh.elements[id].ifc_type.clone()))
        .collect();
    assert_eq!(sample.len(), sampled_types, "{types:?}");
    eprintln!("{path}: sampled linearly placed types {types:?}");
    assert_physical_surfaces(path, &before_mesh, &after_mesh, &geo, &sample);

    // The rigid path (authored scale 1) places the same parts at the same map
    // points modulo the map scale about the map origin.
    let rigid_plan = plan_map_conversion_normalization(rigid_source.as_bytes()).unwrap();
    assert!(rigid_plan.warnings.is_empty(), "{:?}", rigid_plan.warnings);
    let rigid_mesh = world_mesh(&apply_preserving_header(rigid_source, &rigid_plan));
    let origin = nalgebra::Vector3::new(geo.eastings, geo.northings, geo.orthogonal_height);
    assert_mapped_surfaces(path, &rigid_mesh, &after_mesh, &sample, |point| {
        origin + (nalgebra::Vector3::from_column_slice(point) - origin) * 0.9996
    });
    geo
}

/// #7359: buildingSMART's IFC4.3 `linear-placement-of-signal` sample (#859):
/// an alignment, 25 IfcLinearPlacements and `Axis`/`FootPrint` curves. Only
/// the map scale is derived.
#[test]
fn issue_7359_linear_placement_signal_sample_exports_with_utm_scale() {
    let path = "issues/859_linear_placement_of_signal.ifc";
    let Some(bytes) = crate::test_support::fixture_opt(path) else { return };
    let original = String::from_utf8(bytes).expect("fixture is UTF-8");
    assert_scaled_alignment_export(path, &original, 57, 25, 2);
}

/// #7359: ACCA usBIM's public IFC4X3 bridge (rotated map, three alignments,
/// 1,101 IfcLinearPlacements, 620 `Axis`/`FootPrint` curve representations,
/// linearly placed annotations) with a UTM map scale.
#[test]
fn issue_7359_real_alignment_bridge_with_utm_scale_exports_on_the_scaled_path() {
    let path = "buildingsmart/Viadotto_Acerno.ifc";
    let Some(bytes) = crate::test_support::fixture_opt(path) else { return };
    let original = String::from_utf8(bytes).expect("ACCA bridge fixture is UTF-8");
    // Alignments, linear placements and curve representations no longer
    // refuse. The one remaining refusal is the scaled path's separate rule
    // for type geometry no occurrence instantiates: IfcSlabType #253120's
    // map re-wraps an item its slabs already map directly.
    let plan = plan_map_conversion_normalization(with_utm_scale(&original).as_bytes()).unwrap();
    assert_eq!(plan.warnings, ["Map geometry normalization refused: type product #253120 has uninstantiated geometry. No context geometry was changed."]);
    assert!(plan.replacements.is_empty() && plan.new_entities.is_empty());
    // ACCA writes that pattern for all 28 of its type products. Detached
    // (RepresentationMaps $), the whole bridge exports; occurrences carry
    // their own mapped items, so no rendered product changes.
    let detached = detach_uninstantiated_type_maps(&original);
    let (authored, unmapped) = (world_mesh(&original), world_mesh(&detached));
    assert_eq!(authored.elements.keys().collect::<Vec<_>>(), unmapped.elements.keys().collect::<Vec<_>>());
    for (id, mesh) in &authored.elements {
        assert_eq!(mesh.vertices, unmapped.elements[id].vertices, "#{id}");
    }
    let geo = assert_scaled_alignment_export(path, &detached, 7_051, 1_101, 6);
    assert!(geo.x_axis_ordinate.abs() > 0.5, "the authored map is rotated");
}

/// Sets `RepresentationMaps` to `$` on every type product owning a map that
/// no `IfcMappedItem` instantiates.
fn detach_uninstantiated_type_maps(source: &str) -> String {
    let mut decoder = EntityDecoder::new(source);
    let mut scanner = EntityScanner::new(source);
    let mut records = Vec::new();
    let mut instantiated = std::collections::HashSet::new();
    while let Some((id, kind, start, end)) = scanner.next_entity() {
        let kind = IfcType::from_str(kind);
        if kind == IfcType::IfcMappedItem {
            instantiated.insert(decoder.decode_by_id(id).unwrap().get_ref(0).unwrap());
        }
        records.push(Record { id, kind, line: &source[start..end] });
    }
    let replacements: Vec<_> = records.iter()
        .filter(|record| record.kind.is_subtype_of(IfcType::IfcTypeProduct))
        .filter(|record| decoder.decode_by_id(record.id).unwrap().get_refs(6)
            .is_some_and(|maps| maps.iter().any(|map| !instantiated.contains(map))))
        .map(|record| writer::replace(record, &[(6, "$".into())]).unwrap())
        .collect();
    assert_eq!(replacements.len(), 28);
    apply_preserving_header(source, &MapConversionNormalizationPlan { replacements, ..Default::default() })
}

