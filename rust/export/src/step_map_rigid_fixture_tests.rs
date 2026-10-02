// SPDX-License-Identifier: MPL-2.0
//! #6692: original real producers, with the georeferencer's map encoding added.
//! Original fixture bytes remain immutable; derived live-writer witnesses are separate.
use super::*;

pub(super) fn apply_preserving_header(
    source: &str,
    plan: &MapConversionNormalizationPlan,
) -> String {
    let patches: HashMap<_, _> = plan
        .replacements
        .iter()
        .map(|patch| (patch.express_id, patch.line.as_str()))
        .collect();
    let mut scanner = EntityScanner::new(source);
    let mut output = String::new();
    let mut cursor = 0;
    while let Some((id, _, start, end)) = scanner.next_entity() {
        output.push_str(&source[cursor..start]);
        output.push_str(patches.get(&id).copied().unwrap_or(&source[start..end]));
        cursor = end;
    }
    for patch in &plan.new_entities {
        output.push('\n');
        output.push_str(&patch.line);
    }
    output.push_str(&source[cursor..]);
    output
}

fn authored_map(source: &str, rotation: f64, offset: [f64; 3]) -> String {
    let mut scanner = EntityScanner::new(source);
    let mut max_id = 0;
    let mut map = None;
    let mut context = None;
    let mut unit = None;
    let mut decoder = EntityDecoder::new(source);
    while let Some((id, kind, start, end)) = scanner.next_entity() {
        max_id = max_id.max(id);
        if kind == "IFCMAPCONVERSION" {
            map = Some(Record {
                id,
                kind: IfcType::IfcMapConversion,
                line: &source[start..end],
            });
        }
        if kind == "IFCGEOMETRICREPRESENTATIONCONTEXT" {
            let node = decoder.decode_by_id(id).unwrap();
            if node.get_string(1) == Some("Model") {
                context = Some(id);
            }
        }
        if kind == "IFCSIUNIT" {
            let node = decoder.decode_by_id(id).unwrap();
            if node.get(1).and_then(ifc_lite_core::AttributeValue::as_enum) == Some("LENGTHUNIT")
                && node.get(2).unwrap().is_null()
            {
                unit = Some(id);
            }
        }
    }
    let x = writer::real(rotation.to_radians().cos()).unwrap();
    let y = writer::real(rotation.to_radians().sin()).unwrap();
    let coords = offset.map(|value| writer::real(value).unwrap());
    if let Some(map) = map {
        let patch = writer::replace(
            &map,
            &[
                (2, coords[0].clone()),
                (3, coords[1].clone()),
                (4, coords[2].clone()),
                (5, x),
                (6, y),
                (7, "1.".into()),
            ],
        )
        .unwrap();
        return apply_preserving_header(
            source,
            &MapConversionNormalizationPlan {
                replacements: vec![patch],
                ..Default::default()
            },
        );
    }
    let crs = max_id + 1;
    let operation = max_id + 2;
    let entities = format!("#{crs}=IFCPROJECTEDCRS('EPSG:32632',$,$,$,$,$,#{});\n#{operation}=IFCMAPCONVERSION(#{},#{crs},{},{},{},{x},{y},1.);",unit.unwrap(),context.unwrap(),coords[0],coords[1],coords[2]);
    let end = source.rfind("ENDSEC;").unwrap();
    format!("{}\n{entities}\n{}", &source[..end], &source[end..])
}

#[test]
fn issue_6692_real_house_and_minibim_all_product_frames_and_original_records_are_preserved() {
    for (path, count, angle, offset) in [
        (
            "ara3d/AC20-FZK-Haus.ifc",
            127,
            50.,
            [458870.0632856814, 5438773.629049492, 110.],
        ),
        (
            "georeferencer/MiniBIM-3.1-DO_01_VORM.ifc",
            2668,
            15.,
            [90770., 435320., 3.5],
        ),
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/models")
            .join(path);
        let original = match std::fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("SKIP #6692: {} absent; run pnpm fixtures", path.display());
                continue;
            }
            Err(error) => panic!("cannot read producer fixture {}: {error}", path.display()),
        };
        let source = authored_map(&original, angle, offset);
        verify_source(&source, count);
        let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
        let output = apply_preserving_header(&source, &plan);
        let before = super::tests::world_mesh(&source);
        let after = super::tests::world_mesh(&output);
        assert_eq!(
            before.elements.keys().collect::<Vec<_>>(),
            after.elements.keys().collect::<Vec<_>>(),
            "real producer geometry ownership"
        );
        let mut decoder = EntityDecoder::new(&source);
        let mut scanner = EntityScanner::new(&source);
        let mut kinds = Vec::new();
        while let Some((id, kind, _, _)) = scanner.next_entity() {
            kinds.push((id, IfcType::from_str(kind)));
        }
        let geo = GeoRefExtractor::extract(&mut decoder, &kinds)
            .unwrap()
            .unwrap();
        // Sample actual cut hosts, plus a styled door occurrence, through the
        // canonical complete processing path (including RTC and opening CSG).
        let mut representatives = Vec::new();
        for (id, kind) in &kinds {
            if *kind == IfcType::IfcRelVoidsElement && representatives.len() < 3 {
                let relation = decoder.decode_by_id(*id).unwrap();
                if let Some(host) = relation
                    .get_ref(4)
                    .filter(|id| before.elements.contains_key(id))
                {
                    representatives.push(host);
                }
            }
        }
        if let Some(id) = before
            .elements
            .iter()
            .find(|(_, mesh)| mesh.ifc_type == "IfcDoor")
            .map(|(id, _)| *id)
        {
            representatives.push(id);
        }
        assert!(
            !representatives.is_empty(),
            "real opening hosts must be sampled"
        );
        for id in representatives {
            let old = &before.elements[&id];
            let new = &after.elements[&id];
            assert_eq!(new.color, old.color);
            assert_eq!(new.global_id, old.global_id);
            assert_eq!(new.name, old.name);
            let expected: Vec<_> = old
                .vertices
                .iter()
                .map(|point| {
                    let p = geo.local_to_map(point[0], point[1], point[2]);
                    nalgebra::Vector3::new(p.0, p.1, p.2)
                })
                .collect();
            let actual: Vec<_> = new
                .vertices
                .iter()
                .map(|point| nalgebra::Vector3::from_column_slice(point))
                .collect();
            for (points, faces, target, target_faces) in [
                (&expected, &old.faces, &actual, &new.faces),
                (&actual, &new.faces, &expected, &old.faces),
            ] {
                let centroids = faces.iter().map(|face| {
                    (points[face[0] as usize] + points[face[1] as usize] + points[face[2] as usize])
                        / 3.
                });
                for point in points.iter().copied().chain(centroids) {
                    let distance = target_faces
                        .iter()
                        .map(|face| {
                            point_triangle_distance(
                                point,
                                target[face[0] as usize],
                                target[face[1] as usize],
                                target[face[2] as usize],
                            )
                        })
                        .fold(f64::INFINITY, f64::min);
                    assert!(
                        distance < 0.001,
                        "{} product {id}: physical surface distance {distance}",
                        path.display()
                    );
                }
            }
            let area = |points: &[nalgebra::Vector3<f64>], faces: &[[u32; 3]]| {
                faces
                    .iter()
                    .map(|face| {
                        (points[face[1] as usize] - points[face[0] as usize])
                            .cross(&(points[face[2] as usize] - points[face[0] as usize]))
                            .norm()
                            / 2.
                    })
                    .sum::<f64>()
            };
            let old_area = area(&expected, &old.faces);
            let new_area = area(&actual, &new.faces);
            assert!(
                (new_area - old_area).abs() < old_area.max(1.) * 0.001,
                "physical surface area for {id}"
            );
        }
    }
}

pub(super) fn verify_source(source: &str, count: usize) {
    let plan = plan_map_conversion_normalization(source.as_bytes()).unwrap();
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    let output = apply_preserving_header(source, &plan);
    let mut before = EntityDecoder::new(source);
    let mut after = EntityDecoder::new(&output);
    let mut scanner = EntityScanner::new(source);
    let mut types = Vec::new();
    let mut products = Vec::new();
    let mut lines = HashMap::new();
    while let Some((id, kind, start, end)) = scanner.next_entity() {
        let kind = IfcType::from_str(kind);
        if kind.is_subtype_of(IfcType::IfcProduct) {
            products.push(id);
        }
        types.push((id, kind));
        lines.insert(id, &source[start..end]);
    }
    assert_eq!(products.len(), count);
    let geo = GeoRefExtractor::extract(&mut before, &types)
        .unwrap()
        .unwrap();
    let router = GeometryRouter::with_scale(1.);
    let map = Matrix4::from_column_slice(&geo.to_matrix());
    for id in products {
        let old = before.decode_by_id(id).unwrap();
        let new = after.decode_by_id(id).unwrap();
        let old_frame = Matrix4::from_column_slice(
            &router
                .resolve_scaled_placement_strict(&old, &mut before)
                .unwrap(),
        );
        let new_frame = Matrix4::from_column_slice(
            &router
                .resolve_scaled_placement_strict(&new, &mut after)
                .unwrap(),
        );
        assert!(
            (new_frame - map * old_frame).amax() < 1e-8,
            "world frame for #{id}"
        );
        assert_eq!(old.get_ref(5), new.get_ref(5));
        assert_eq!(old.get_ref(6), new.get_ref(6));
    }
    let changed: std::collections::HashSet<_> = plan
        .replacements
        .iter()
        .map(|patch| patch.express_id)
        .collect();
    let mut scanner = EntityScanner::new(&output);
    while let Some((id, _, start, end)) = scanner.next_entity() {
        if let Some(original) = lines.get(&id).filter(|_| !changed.contains(&id)) {
            assert_eq!(
                *original,
                &output[start..end],
                "unchanged source entity #{id}"
            );
        }
    }
    for patch in &plan.replacements {
        let node = before.decode_by_id(patch.express_id).unwrap();
        if node.ifc_type == IfcType::IfcGeometricRepresentationContext {
            let old_north = node
                .get_ref(5)
                .map(|id| {
                    let direction = before.decode_by_id(id).unwrap();
                    let ratios = direction.get_list(0).unwrap();
                    nalgebra::Vector3::new(
                        ratios[0].as_float().unwrap(),
                        ratios[1].as_float().unwrap(),
                        0.,
                    )
                    .normalize()
                })
                .unwrap_or(nalgebra::Vector3::y());
            let new_context = after.decode_by_id(patch.express_id).unwrap();
            let new_north = after.decode_by_id(new_context.get_ref(5).unwrap()).unwrap();
            let ratios = new_north.get_list(0).unwrap();
            let actual = nalgebra::Vector3::new(
                ratios[0].as_float().unwrap(),
                ratios[1].as_float().unwrap(),
                0.,
            );
            let expected = map.fixed_view::<3, 3>(0, 0) * old_north;
            assert!(
                (actual - expected.normalize()).norm() < 1e-12,
                "real producer TrueNorth covariance #{}",
                patch.express_id
            );
        }
        assert!(matches!(
            node.ifc_type,
            IfcType::IfcLocalPlacement
                | IfcType::IfcMapConversion
                | IfcType::IfcGeometricRepresentationContext
        ));
    }
}

/// Independent test oracle: nearest point on triangle interior or its edges.
/// CSG may triangulate the same physical surface differently after rotation.
fn point_triangle_distance(
    p: nalgebra::Vector3<f64>,
    a: nalgebra::Vector3<f64>,
    b: nalgebra::Vector3<f64>,
    c: nalgebra::Vector3<f64>,
) -> f64 {
    let ab = b - a;
    let ac = c - a;
    let ap = p - a;
    let normal = ab.cross(&ac);
    let length_squared = normal.norm_squared();
    if length_squared > 1e-30 {
        let projected = p - normal * (ap.dot(&normal) / length_squared);
        let offset = projected - a;
        let denominator = ab.dot(&ab) * ac.dot(&ac) - ab.dot(&ac).powi(2);
        if denominator > 1e-30 {
            let u = (ac.dot(&ac) * offset.dot(&ab) - ab.dot(&ac) * offset.dot(&ac)) / denominator;
            let v = (ab.dot(&ab) * offset.dot(&ac) - ab.dot(&ac) * offset.dot(&ab)) / denominator;
            if u >= -1e-10 && v >= -1e-10 && u + v <= 1. + 1e-10 {
                return (p - projected).norm();
            }
        }
    }
    [(a, b), (b, c), (c, a)]
        .iter()
        .map(|(a, b)| {
            let delta = b - a;
            let t = if delta.norm_squared() == 0. {
                0.
            } else {
                (p - a).dot(&delta) / delta.norm_squared()
            };
            (p - (a + delta * t.clamp(0., 1.))).norm()
        })
        .fold(f64::INFINITY, f64::min)
}

#[test]
fn issue_6692_surface_oracle_distinguishes_interior_edges_and_actual_displacement() {
    let a = nalgebra::Vector3::new(0., 0., 0.);
    let b = nalgebra::Vector3::new(1., 0., 0.);
    let c = nalgebra::Vector3::new(0., 1., 0.);
    assert_eq!(
        point_triangle_distance(nalgebra::Vector3::new(0.25, 0.25, 0.), a, b, c),
        0.
    );
    assert_eq!(
        point_triangle_distance(nalgebra::Vector3::new(0.25, 0.25, 0.12), a, b, c),
        0.12
    );
    assert_eq!(
        point_triangle_distance(nalgebra::Vector3::new(0.5, -0.25, 0.), a, b, c),
        0.25
    );
}
