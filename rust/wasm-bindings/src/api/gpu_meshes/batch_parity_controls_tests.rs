// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7782 mutation controls exercise real producer payloads and the gate.
use super::{compare, evidence, gate, observe, MULTICOLOR};
use ifc_lite_processing::{MeshData, MeshFrame};

type Mutation = (&'static str, fn(&mut MeshData));

#[test]
fn full_payload_mutations_fail_in_exact_and_world_modes_7782() {
    let native = observe::native(&observe::fixture(MULTICOLOR));
    let original = native
        .meshes
        .first()
        .expect("real multi-colour fixture draws");
    let mutations: &[Mutation] = &[
        ("positions", |m| m.positions[0] += 0.125),
        ("normals", |m| m.normals[0] += 0.125),
        ("indices", |m| m.indices.swap(0, 1)),
        ("colour", |m| {
            m.color[0] = f32::from_bits(m.color[0].to_bits() ^ 1)
        }),
        ("material name", |m| {
            m.material_name = Some("injected".into())
        }),
        ("material id", |m| m.material_id = Some(u32::MAX)),
        ("presentation layer", |m| {
            m.presentation_layer = Some("injected".into())
        }),
        ("layer class", |m| m.geometry_class = 3),
        ("bounds", |m| {
            m.local_bounds = Some([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
        }),
        ("placement presence", |m| {
            m.local_to_world = if m.local_to_world.is_some() {
                None
            } else {
                Some([1.0; 16])
            }
        }),
        ("placement value", |m| {
            m.local_to_world.get_or_insert([0.0; 16])[3] += 12.0
        }),
        ("placement NaN", |m| m.local_to_world = Some([f64::NAN; 16])),
        ("uv", |m| {
            m.uvs = Some(vec![0.25; m.positions.len() / 3 * 2])
        }),
        ("origin", |m| m.origin[0] += 1.0),
        ("item", |m| m.geometry_item_id = Some(u32::MAX)),
    ];
    for frames in [None, Some((MeshFrame::RawIfc, MeshFrame::RawIfc))] {
        let mut unchanged = Vec::new();
        compare::compare_meshes("control", &[original], &[original], frames, &mut unchanged);
        assert!(unchanged.is_empty(), "unmutated fixture must pass");
        for &(name, mutate) in mutations {
            let mut changed = original.clone();
            mutate(&mut changed);
            let mut drifts = Vec::new();
            compare::compare_meshes("control", &[original], &[&changed], frames, &mut drifts);
            assert!(!drifts.is_empty(), "{name} escaped in {frames:?}");
        }
    }
}

#[test]
fn existing_material_exception_cannot_hide_a_position_change_7782() {
    let native = observe::native(&observe::fixture(MULTICOLOR));
    let original = native.meshes.first().unwrap();
    let mut browser = original.clone();
    browser.material_name = Some("existing known difference".into());
    let mut drifts = Vec::new();
    compare::compare_meshes("control", &[original], &[&browser], None, &mut drifts);
    let before = evidence::binding(&[original], &[&browser], &drifts[0]);
    let expected = serde_json::json!({"evidence": before});
    assert!(gate::reconcile(&[before], std::slice::from_ref(&expected)).is_empty());
    browser.positions[0] = f32::from_bits(browser.positions[0].to_bits() ^ 1);
    let mut changed = Vec::new();
    compare::compare_meshes("control", &[original], &[&browser], None, &mut changed);
    assert_eq!(drifts[0].key(), changed[0].key(), "same existing exception");
    let after = evidence::binding(&[original], &[&browser], &changed[0]);
    assert!(!gate::reconcile(&[after], &[expected]).is_empty());
}

#[test]
fn refusal_absent_invalid_present_and_wrong_values_are_distinct_7782() {
    let cases = [
        None,
        Some(serde_json::json!({})),
        Some(serde_json::json!({"refusedInputElements":"invalid", "refusedPrepassRecords":0})),
        Some(serde_json::json!({"refusedInputElements":1, "refusedPrepassRecords":0})),
    ];
    let mut details = std::collections::BTreeSet::new();
    for pipeline in cases {
        let mut drifts = Vec::new();
        compare::compare_refusals("control", (0, 0), pipeline.as_ref(), &mut drifts);
        assert_eq!(drifts.len(), 1);
        assert!(details.insert(drifts[0].detail.clone()));
    }
    let mut drifts = Vec::new();
    compare::compare_refusals(
        "control",
        (0, 0),
        Some(&serde_json::json!({
        "refusedInputElements":0, "refusedPrepassRecords":0})),
        &mut drifts,
    );
    assert!(drifts.is_empty());
}

#[test]
fn swapping_appearance_or_placement_between_meshes_is_not_parity_7782() {
    let native = observe::native(&observe::fixture(MULTICOLOR));
    let mut first = native.meshes[0].clone();
    let mut second = first.clone();
    second.positions[0] += 2.0;
    first.color = [1.0, 0.0, 0.0, 1.0];
    second.color = [0.0, 0.0, 1.0, 1.0];
    first.local_to_world = Some([0.0; 16]);
    second.local_to_world = Some([1.0; 16]);
    for swap_color in [true, false] {
        let (mut a, mut b) = (first.clone(), second.clone());
        if swap_color {
            std::mem::swap(&mut a.color, &mut b.color);
        } else {
            std::mem::swap(&mut a.local_to_world, &mut b.local_to_world);
        }
        for frames in [None, Some((MeshFrame::RawIfc, MeshFrame::RawIfc))] {
            let mut drifts = Vec::new();
            compare::compare_meshes(
                "control",
                &[&first, &second],
                &[&a, &b],
                frames,
                &mut drifts,
            );
            assert!(drifts.iter().any(|d| d.axis == compare::Axis::MeshHash));
        }
    }
}

#[test]
fn type_product_dispatch_expands_to_map_units_without_deduplication_7782() {
    // Two distinct RepresentationMaps reference the same shape: geometry alone
    // cannot distinguish a lost/duplicated map identity. The fixture invariant
    // names both source maps and the actual batch tap must preserve them.
    let source = String::from_utf8(observe::fixture(super::TYPE_MODES)).unwrap();
    let source = source
        .replace("(#16),$,$,.NOTDEFINED.)", "(#16,#117),$,$,.NOTDEFINED.)")
        .replace(
            "#116=IFCREPRESENTATIONMAP",
            "#117=IFCREPRESENTATIONMAP(#15,#13);\n#116=IFCREPRESENTATIONMAP",
        );
    let native = observe::native(source.as_bytes());
    let browser = observe::browser_cold(source.as_bytes());
    let native_jobs = observe::native_jobs(source.as_bytes(), &native, &browser.prepass);
    assert_eq!(native_jobs.get(&100), Some(&2), "native one job per map");
    let maps: Vec<_> = browser
        .batches
        .iter()
        .flat_map(|b| &b.planned_jobs)
        .filter(|j| j.0 == 100)
        .copied()
        .collect();
    assert_eq!(maps, [(100, Some(16), 1), (100, Some(117), 1)]);
    assert_eq!(super::browser_job_units(&browser).get(&100), Some(&2));
    let native_meshes: Vec<_> = native.meshes.iter().collect();
    let browser_meshes: Vec<_> = browser.meshes().collect();
    let mut units = super::browser_job_units(&browser);
    let mut drifts = Vec::new();
    compare::type_coverage(
        "multi-map-control",
        &native_meshes,
        &browser_meshes,
        &native_jobs,
        &units,
        &mut drifts,
    );
    assert!(drifts.is_empty(), "equal expanded units: {drifts:?}");
    units.insert(100, 1); // The old, wrong wire-product unit loses a map.
    compare::type_coverage(
        "multi-map-control",
        &native_meshes,
        &browser_meshes,
        &native_jobs,
        &units,
        &mut drifts,
    );
    assert!(drifts
        .iter()
        .any(|d| d.axis == compare::Axis::JobSet && d.element == Some(100)));
}
