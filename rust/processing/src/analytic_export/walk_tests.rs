// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn issue_5786_mapped_extrusion_source_cache_preserves_quantities_and_instances() {
    let content = include_bytes!("../../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let ids = HashSet::from([31, 38]);
    let mut cached = MappedSourceCache::new();
    let actual = extract_with_source_cache(content, Some(&ids), false, false, true, &mut cached);
    let mut uncached = MappedSourceCache::new();
    uncached.enabled = false;
    let expected = extract_with_source_cache(content, Some(&ids), false, false, true, &mut uncached);

    assert_eq!((cached.loads, cached.hits, uncached.loads), (1, 1, 2));
    assert_eq!(serde_json::to_value(&actual.extrusions).unwrap(),
        serde_json::to_value(&expected.extrusions).unwrap());
    let view = actual.extrusions.unwrap();
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    assert_eq!(view.sources.len(), 1);
    assert!(view.sources[0].nominal_quantities.is_some());
    assert_eq!(view.instances.len(), 2);
    assert_ne!(view.instances[&31][0].world_from_source,
        view.instances[&38][0].world_from_source);
}

#[test]
fn issue_5786_revit_mapped_sources_are_loaded_once_without_changing_analytic_order() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc");
    let Ok(content) = std::fs::read(path) else {
        eprintln!("Skipping catalogued Revit Snowdon fixture; run pnpm fixtures");
        return;
    };

    for (definitions, descriptions, extrusions) in
        [(false, true, false), (true, true, false), (false, false, true)]
    {
        let mut cached = MappedSourceCache::new();
        let actual = extract_with_source_cache(
            &content, None, definitions, descriptions, extrusions, &mut cached,
        );
        let mut uncached = MappedSourceCache::new();
        uncached.enabled = false;
        let expected = extract_with_source_cache(
            &content, None, definitions, descriptions, extrusions, &mut uncached,
        );

        assert!(cached.hits > 0, "Revit fixture must exercise shared mapped sources");
        assert!(cached.loads < uncached.loads,
            "cached source loads {} must be fewer than uncached {}",
            cached.loads, uncached.loads);
        eprintln!("Revit mapped source loads: cached {}, uncached {}, cache hits {}",
            cached.loads, uncached.loads, cached.hits);
        assert_eq!(serde_json::to_value(&actual.descriptions).unwrap(),
            serde_json::to_value(&expected.descriptions).unwrap());
        assert_eq!(serde_json::to_value(&actual.definitions).unwrap(),
            serde_json::to_value(&expected.definitions).unwrap());
        assert_eq!(serde_json::to_value(&actual.extrusions).unwrap(),
            serde_json::to_value(&expected.extrusions).unwrap());
        assert!(actual.definitions.as_ref().is_none_or(|view| !view.sources.is_empty()),
            "Revit fixture must exercise real swept-disk sources");
        assert!(actual.extrusions.as_ref().is_none_or(|view| !view.sources.is_empty()),
            "Revit fixture must exercise real extrusion sources");
    }
}

#[test]
fn issue_5786_shared_source_cache_preserves_distinct_target_transforms() {
    let fixture = include_str!("../../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
    let model = fixture.replace(
        "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));",
        "#1000=IFCCARTESIANPOINT((5000.,0.,0.));\n#1001=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1000,$,$);\n#1002=IFCMAPPEDITEM(#45,#1001);\n#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47,#1002));",
    );
    for definitions in [false, true] {
        let mut cached = MappedSourceCache::new();
        let actual = extract_with_source_cache(
            model.as_bytes(), None, definitions, true, false, &mut cached,
        );
        let mut uncached = MappedSourceCache::new();
        uncached.enabled = false;
        let expected = extract_with_source_cache(
            model.as_bytes(), None, definitions, true, false, &mut uncached,
        );
        assert_eq!((cached.loads, cached.hits, uncached.loads), (1, 1, 2));
        assert_eq!(serde_json::to_value(&actual.descriptions).unwrap(),
            serde_json::to_value(&expected.descriptions).unwrap());
        assert_eq!(serde_json::to_value(&actual.definitions).unwrap(),
            serde_json::to_value(&expected.definitions).unwrap());
        if definitions {
            let instances = &actual.definitions.unwrap().instances[&50];
            assert_eq!(instances.len(), 2);
            assert_ne!(instances[0].world_from_source, instances[1].world_from_source);
        } else {
            assert_eq!(actual.descriptions.elements[&50].len(), 2);
            assert_ne!(actual.descriptions.elements[&50][0].directrix[0],
                actual.descriptions.elements[&50][1].directrix[0]);
        }
    }
}

#[test]
fn issue_5786_many_mapped_occurrences_decode_one_source_and_keep_each_target() {
    let fixture = include_str!("../../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
    let mut mapped_ids = vec![47];
    let mut added = String::new();
    for index in 1..64 {
        let point_id = 2000 + index * 3;
        let operator_id = point_id + 1;
        let mapped_id = point_id + 2;
        added.push_str(&format!(
            "#{point_id}=IFCCARTESIANPOINT(({},0.,0.));\n\
             #{operator_id}=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#{point_id},$,$);\n\
             #{mapped_id}=IFCMAPPEDITEM(#45,#{operator_id});\n",
            index * 100,
        ));
        mapped_ids.push(mapped_id);
    }
    let source = format!("{added}#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',({}));",
        mapped_ids.iter().map(|id| format!("#{id}")).collect::<Vec<_>>().join(","));
    let model = fixture.replace(
        "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));",
        &source,
    );
    for (definitions, descriptions) in [(false, true), (true, false)] {
        let mut cached = MappedSourceCache::new();
        let actual = extract_with_source_cache(
            model.as_bytes(), None, definitions, descriptions, false, &mut cached,
        );
        let mut uncached = MappedSourceCache::new();
        uncached.enabled = false;
        let expected = extract_with_source_cache(
            model.as_bytes(), None, definitions, descriptions, false, &mut uncached,
        );

        assert_eq!((cached.loads, cached.hits, uncached.loads), (1, 63, 64));
        assert_eq!(serde_json::to_value(&actual.descriptions).unwrap(),
            serde_json::to_value(&expected.descriptions).unwrap());
        assert_eq!(serde_json::to_value(&actual.definitions).unwrap(),
            serde_json::to_value(&expected.definitions).unwrap());
        if definitions {
            let view = actual.definitions.unwrap();
            assert_eq!(view.sources.len(), 1);
            let instances = &view.instances[&50];
            assert_eq!(instances.len(), 64);
            assert!(instances.windows(2).all(|pair|
                pair[0].world_from_source != pair[1].world_from_source));
        } else {
            let occurrences = &actual.descriptions.elements[&50];
            assert_eq!(occurrences.len(), 64);
            assert!(occurrences.windows(2).all(|pair|
                pair[0].directrix[0] != pair[1].directrix[0]));
        }
    }
}

#[test]
fn issue_5786_nested_mirrored_scaled_maps_keep_order_and_world_frames() {
    let fixture = include_str!("../../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
    let model = fixture.replace(
        "#45=IFCREPRESENTATIONMAP(#13,#44);",
        "#1009=IFCCARTESIANPOINT((100.,20.,0.));\n\
         #1010=IFCAXIS2PLACEMENT3D(#1009,$,$);\n\
         #45=IFCREPRESENTATIONMAP(#1010,#44);",
    ).replace(
        "#48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47));",
        "#1000=IFCCARTESIANPOINT((5000.,0.,0.));\n\
         #1001=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1000,2.,$);\n\
         #1002=IFCMAPPEDITEM(#45,#1001);\n\
         #48=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#47,#1002));",
    ).replace(
        "#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));",
        "#1003=IFCDIRECTION((0.,-1.,0.));\n\
         #1004=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#12,#1003,#10,$,$);\n\
         #1005=IFCREPRESENTATIONMAP(#13,#48);\n\
         #1006=IFCMAPPEDITEM(#1005,#1004);\n\
         #1007=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,3.,$);\n\
         #1008=IFCMAPPEDITEM(#1005,#1007);\n\
         #1011=IFCSHAPEREPRESENTATION(#16,'Body','MappedRepresentation',(#1006,#1008));\n\
         #49=IFCPRODUCTDEFINITIONSHAPE($,$,(#1011));",
    );

    for (definitions, descriptions) in [(false, true), (true, false)] {
        let mut cached = MappedSourceCache::new();
        let actual = extract_with_source_cache(
            model.as_bytes(), None, definitions, descriptions, false, &mut cached,
        );
        let mut uncached = MappedSourceCache::new();
        uncached.enabled = false;
        let expected = extract_with_source_cache(
            model.as_bytes(), None, definitions, descriptions, false, &mut uncached,
        );
        assert_eq!((cached.loads, cached.hits, uncached.loads), (2, 4, 6));
        assert!(actual.descriptions.diagnostics.is_empty(),
            "{:?}", actual.descriptions.diagnostics);
        assert_eq!(serde_json::to_value(&actual.descriptions).unwrap(),
            serde_json::to_value(&expected.descriptions).unwrap());
        assert_eq!(serde_json::to_value(&actual.definitions).unwrap(),
            serde_json::to_value(&expected.definitions).unwrap());

        if definitions {
            let instances = &actual.definitions.unwrap().instances[&50];
            let paths: Vec<_> = instances.iter().map(|instance| instance.mapping_path.as_slice()).collect();
            assert_eq!(paths, [
                &[1006, 47][..], &[1006, 1002], &[1008, 47], &[1008, 1002],
            ]);
            let matrices: Vec<_> = instances.iter().map(|instance|
                instance.world_from_source.expect("valid mapped world transform")).collect();
            for (index, (scale, x, y)) in [
                (0.001, 0.1, -0.02), (0.002, 5.2, -0.04),
                (0.003, 0.3, 0.06), (0.006, 15.6, 0.12),
            ].into_iter().enumerate() {
                assert!((matrices[index][0] - scale).abs() < 1e-12);
                assert!((matrices[index][12] - x).abs() < 1e-10);
                assert!((matrices[index][13] - y).abs() < 1e-10);
            }
            assert!(matrices[0][5] < 0.0 && matrices[1][5] < 0.0);
            assert!(matrices[2][5] > 0.0 && matrices[3][5] > 0.0);
        } else {
            let occurrences = &actual.descriptions.elements[&50];
            assert_eq!(occurrences.len(), 4);
            assert_eq!(occurrences.iter().map(|item| item.mapping_path.as_slice()).collect::<Vec<_>>(),
                vec![&[1006, 47][..], &[1006, 1002], &[1008, 47], &[1008, 1002]]);
            for (item, radius) in occurrences.iter().zip([0.0145, 0.029, 0.0435, 0.087]) {
                assert!((item.radius - radius).abs() < 1e-12);
            }
        }
    }
}

#[test]
fn issue_5786_invalid_shared_source_reports_each_product() {
    let fixture = include_str!("../../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
    let model = fixture.replace(
        "#45=IFCREPRESENTATIONMAP(#13,#44);",
        "#45=IFCREPRESENTATIONMAP(#10,#44);",
    ).replace("ENDSEC;\nEND-ISO-10303-21;",
        "#51=IFCREINFORCINGBAR('0000000000000000000003',$,'Bar copy',$,$,#30,#49,'BAR-2',$,29.,0.,$,.NOTDEFINED.,$);\nENDSEC;\nEND-ISO-10303-21;");
    let mut cache = MappedSourceCache::new();
    let result = extract_with_source_cache(model.as_bytes(), None, true, true, false, &mut cache);
    assert_eq!((cache.loads, cache.hits), (2, 0),
        "malformed shared sources must be validated for each occurrence");
    assert!(result.descriptions.elements.is_empty());
    assert!(result.definitions.as_ref().unwrap().instances.is_empty());
    for id in [50, 51] {
        assert!(result.descriptions.diagnostics.iter().any(|message|
            message.contains(&format!("product #{id}: mapped item #47"))
                && message.contains("MappingOrigin")),
            "missing diagnostic for product #{id}: {:?}", result.descriptions.diagnostics);
    }
}

#[test]
fn issue_5786_target_parse_error_precedes_origin_parse_error() {
    let fixture = include_str!("../../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
    let model = fixture.replace(
        "#45=IFCREPRESENTATIONMAP(#13,#44);",
        "#1001=IFCDIRECTION($);\n#1003=IFCCARTESIANPOINT($);\n#1004=IFCAXIS2PLACEMENT3D(#1003,$,$);\n#45=IFCREPRESENTATIONMAP(#1004,#44);",
    ).replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1001,$,#10,$,$);",
    );
    let mut cache = MappedSourceCache::new();
    let result = extract_with_source_cache(model.as_bytes(), None, false, true, false, &mut cache);
    assert!(result.descriptions.elements.is_empty());
    assert!(result.descriptions.diagnostics.iter().any(|message|
        message.contains("product #50: mapped item #47: mapped transform: ")
            && message.contains("IfcDirection missing ratios")),
        "target parse must win over independently malformed origin: {:?}",
        result.descriptions.diagnostics);
}
