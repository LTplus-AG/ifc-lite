// SPDX-License-Identifier: MPL-2.0
//! Synthetic qualification controls for #7955, canonical current exact producer.
//! No retained-runtime or persistent-engine-face-identity claim is made here.
#[path = "synthetic_7955_support/mod.rs"]
mod support;
use ifc_lite_processing::{process, ProcessingRequest, TessellationQuality};
use serde_json::Value;
use support::*;

#[test]
fn issue_7955_curved_layers_and_cross_layer_opening() {
    let source = fixture("f-a-curved.ifc");
    let oracle = case("f-a-curved.ifc");
    let result = run(&source);
    check_products(&result, &oracle, true).unwrap();
    let bands = oracle["bands"].as_array().unwrap();
    assert_eq!(bands.len(), 3);
    let sum: f64 = bands.iter().map(|b| number(&b["after"])).sum();
    assert!((sum - number(&oracle["after_total"])).abs() < 1e-10);
    // Kill a missing all-layer cut using an actual input mutation. No changed tolerance.
    let relation = integer(&oracle["products"][0]["void_relation"]);
    let mutant = without_entity(&source, relation);
    assert!(
        check_products(&run(&mutant), &oracle, true).is_err(),
        "missing wall opening must be detected"
    );
    // Also check the uncut HOST against the independently integrated full shell.
    let mut uncut = oracle.clone();
    uncut["products"][0]["volume"] = oracle["before_total"].clone();
    check_products(&run(&mutant), &uncut, true).unwrap();
}

#[test]
fn issue_7955_mapped_occurrence_volumes_and_appearance() {
    let source = fixture("f-b-mapped.ifc");
    let oracle = case("f-b-mapped.ifc");
    let result = run(&source);
    check_products(&result, &oracle, false).unwrap();
    check_appearance(&result, &oracle).unwrap();
    let row = oracle["products"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["role"] == "door-left")
        .unwrap();
    let mutant = without_entity(&source, integer(&row["void_relation"]));
    assert!(
        check_products(&run(&mutant), &oracle, false).is_err(),
        "uncut mapped occurrence must fail volume oracle"
    );
    let mut wrong = result.meshes.clone();
    let red = product_id(&oracle, "red");
    for m in &mut wrong {
        if m.express_id == red {
            m.color = [0.5, 0.5, 0.5, 1.];
        }
    }
    let mut mutated = run(&source);
    mutated.meshes = wrong;
    assert!(
        check_appearance(&mutated, &oracle).is_err(),
        "dropped occurrence style must be detected"
    );
    let mut wrong_palette = run(&source);
    for m in &mut wrong_palette.meshes {
        if m.express_id == product_id(&oracle, "palette") {
            m.color.swap(0, 2);
        }
    }
    assert!(
        check_appearance(&wrong_palette, &oracle).is_err(),
        "swapped palette binding killed despite unchanged colour counts"
    );
}

#[test]
fn issue_7955_mapped_instances_preserve_occurrences_and_cuts() {
    let source = fixture("f-b-mapped.ifc");
    let oracle = case("f-b-mapped.ifc");
    let result = process(
        source.as_bytes(),
        &ProcessingRequest::full_pass().instancing(true),
        &mut (),
    );
    // Different cut domains cannot share an unchanged definition. Exact may
    // share color-independent geometry; the JSON policy is stricter retained eligibility.
    for role in ["door-left", "door-right"] {
        let id = product_id(&oracle, role);
        assert!(
            result.instances.iter().all(|i| i.express_id != id),
            "cut occurrence must be realized"
        );
    }
    assert!(
        !result.instances.is_empty(),
        "the repeated map must actually exercise instancing"
    );
    let mut mutant = expand_instances(result);
    check_products(&mutant, &oracle, false).unwrap();
    check_appearance(&mutant, &oracle).unwrap();
    mutant
        .meshes
        .retain(|m| m.express_id != product_id(&oracle, "rotated"));
    assert!(
        check_products(&mutant, &oracle, false).is_err(),
        "missing occurrence killed"
    );
}

#[test]
fn issue_7955_reexport_semantic_faces_survive_ids_order_and_representation() {
    let mut observations = Vec::new();
    for name in ["f-c-extrusion.ifc", "f-c-brep.ifc"] {
        let source = fixture(name);
        let oracle = case(name);
        let result = run(&source);
        check_single(&result, &oracle).unwrap();
        if name == "f-c-extrusion.ifc" {
            let mutant = source
                .lines()
                .map(|line| {
                    if line.contains("=IFCEXTRUDEDAREASOLID(") {
                        line.replace(",3.);", ",3.25);")
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                check_single(&run(&mutant), &oracle).is_err(),
                "changed source height killed"
            );
        }
        let areas = semantic_faces(&result, &oracle).unwrap();
        assert_eq!(areas.len(), 6);
        observations.push(areas);
        // Geometry-equivalent triangle order must not change semantic roles.
        let mut reordered = run(&source);
        for m in &mut reordered.meshes {
            let reversed: Vec<u32> = m.indices.chunks_exact(3).rev().flatten().copied().collect();
            m.indices = reversed;
        }
        assert_eq!(
            semantic_faces(&reordered, &oracle)
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            observations.last().unwrap().keys().collect::<Vec<_>>()
        );
        // Wrong source frame must not authenticate a face by ordinal.
        let mut wrong_frame = oracle.clone();
        wrong_frame["translation"][0] = Value::from(number(&oracle["translation"][0]) + 0.1);
        assert!(
            semantic_faces(&result, &wrong_frame).is_err(),
            "wrong semantic frame killed"
        );
    }
    assert_eq!(
        observations[0].keys().collect::<Vec<_>>(),
        observations[1].keys().collect::<Vec<_>>()
    );
    for (key, area) in &observations[0] {
        assert!(
            (area - observations[1][key]).abs() < tolerance("position_absolute") * 12.,
            "face area differs: {key}"
        );
    }
}

#[test]
fn issue_7955_image_sidecar_uvs_and_pixels() {
    let source = fixture("f-d-texture.ifc");
    let oracle = case("f-d-texture.ifc");
    let result = run(&source);
    check_single(&result, &oracle).unwrap();
    check_uv(&result, &oracle).unwrap();
    let bytes = std::fs::read(root().join("checker.png")).unwrap();
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut pixels).unwrap();
    assert_eq!((info.width, info.height), (2, 2));
    assert_eq!(
        &pixels[..info.buffer_size()],
        &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]
    );
    let mut mutant = run(&source);
    for mesh in &mut mutant.meshes {
        if let Some(uv) = &mut mesh.uvs {
            for pair in uv.chunks_exact_mut(2) {
                pair[1] = 1. - pair[1];
            }
        }
    }
    assert!(
        check_uv(&mutant, &oracle).is_err(),
        "missing GPU V flip killed"
    );
}

#[test]
fn issue_7955_curved_quality_does_not_change_analytic_oracle() {
    let source = fixture("f-a-curved.ifc");
    let oracle = case("f-a-curved.ifc");
    let result = process(
        source.as_bytes(),
        &ProcessingRequest::full_pass().quality(TessellationQuality::Highest),
        &mut (),
    );
    check_products(&result, &oracle, true).unwrap();
}
