// SPDX-License-Identifier: MPL-2.0
//! Exercise source ownership and all three output adapters with real production.
use super::super::batch_wire::{BatchSource, BatchWire};
use crate::api::IfcAPI;
use std::sync::Arc;

#[test]
fn c4_10b_held_and_borrowed_outputs_keep_hash_frame_and_provenance_7782() {
    let source =
        include_bytes!("../../../../processing/tests/fixtures/c4_0_refusal_parity_7782.ifc");
    let api = IfcAPI::new();
    let pre = api.build_prepass_once_data(source);
    api.set_compute_geometry_hashes(Some(1e-5));
    let mut jobs = vec![0; pre.total_jobs() * 3];
    pre.write_jobs(|i, v| jobs[i as usize] = v);
    // An incomplete trailing job remains ignored, including with a warm decoder.
    jobs.extend([123, 0]);
    let wire = || BatchWire {
        jobs_flat: &jobs,
        unit_scale: 1.0,
        rtc_x: 10.0,
        rtc_y: 20.0,
        rtc_z: 30.0,
        needs_shift: true,
        void_keys: &pre.void_keys,
        void_counts: &pre.void_counts,
        void_values: &pre.void_values,
        style_ids: &pre.style_ids,
        style_colors: &pre.style_colors,
        plane_angle_to_radians: Some(pre.meta.plane_angle_to_radians),
        material_element_ids: None,
        material_color_counts: None,
        material_colors_rgba: None,
    };
    let flat = api.batch_flat(BatchSource::Borrowed(source), wire());
    let held_source = Arc::new(source.to_vec());
    let held = api.batch_flat(BatchSource::Held(Arc::clone(&held_source)), wire());
    assert_eq!(
        Arc::strong_count(&held_source),
        1,
        "batch releases its held source owner"
    );
    for collection in [&flat, &held] {
        assert_eq!(
            collection.length(),
            1,
            "valid neighbour survives refused leaves"
        );
        assert!(collection.total_triangles() > 0);
        assert_eq!(
            collection.geometry_hash_count(),
            1,
            "diff metadata survives output routing"
        );
        assert_eq!(
            (
                collection.rtc_offset_x(),
                collection.rtc_offset_y(),
                collection.rtc_offset_z()
            ),
            (10.0, 20.0, 30.0)
        );
        assert_eq!(collection.get(0).unwrap().express_id(), 300);
        assert_eq!(collection.get(0).unwrap().geometry_item_id(), Some(301));
    }
    assert_eq!(flat.total_vertices(), held.total_vertices());
    assert_eq!(flat.total_triangles(), held.total_triangles());
    let mut partition = api.batch_partitioned(BatchSource::Held(held_source), wire());
    let part_flat = partition.take_meshes().unwrap();
    assert_eq!(part_flat.total_triangles(), flat.total_triangles());
    assert_eq!(part_flat.geometry_hash_count(), 1);
    assert_eq!(
        partition.instanced_occurrences(),
        0,
        "shifted hashing path stays materialized"
    );
    let shard = api.batch_instanced(BatchSource::Borrowed(source), wire());
    assert!(
        !shard.is_empty(),
        "instanced-only output retains singleton geometry"
    );
}
