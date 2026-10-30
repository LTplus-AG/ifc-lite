// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C4-7b (#8341) measurement harness. NOT compiled by CI: `measure.sh` copies
//! it, unchanged, into `rust/wasm-bindings/src/api/gpu_meshes/` on both the
//! base and the head checkout. It only calls APIs both sides share.
//!
//! `C4_7B_MODE`:
//! * `parts` / `parts-setup`: worker merge-layers first batch. The worker
//!   wire's entity index and material-layer index are installed (setup), then
//!   `get_or_build_parts_to_skip` runs (measured).
//! * `once` / `once-setup`: `buildPrePassOnce` plus one batch holding the
//!   first type-product job (or no job), the work that reaches every lazy
//!   fallback without meshing the model.
//! * `identity`: full once path (every job, merge layers off and on) and the
//!   worker parts set, printed as hashes for a base/head comparison.
use crate::api::gpu_meshes::batch_wire::BatchWire;
use crate::api::gpu_meshes::prepass_once::PrepassOnceData;
use crate::api::gpu_meshes::prepass_sharded::stream_meta_unit_scale;
use crate::api::IfcAPI;
use ifc_lite_core::{ColumnarEntityIndex, EntityDecoder, IfcType};

fn fnv(hash: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *hash ^= u64::from(b);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

fn jobs_wire(prepass: &PrepassOnceData) -> Vec<u32> {
    let mut jobs = vec![u32::MAX; prepass.total_jobs() * 3];
    prepass.write_jobs(|index, value| jobs[index as usize] = value);
    jobs
}

fn batch(api: &IfcAPI, content: &[u8], prepass: &PrepassOnceData, jobs: &[u32]) -> u64 {
    let (rtc_x, rtc_y, rtc_z) = prepass.meta.frame.rtc_offset();
    let (outputs, diagnostics, _) = api.produce_batch(content, &BatchWire {
        jobs_flat: jobs,
        unit_scale: stream_meta_unit_scale(&prepass.meta),
        rtc_x,
        rtc_y,
        rtc_z,
        needs_shift: prepass.meta.frame.needs_shift(),
        void_keys: &prepass.void_keys,
        void_counts: &prepass.void_counts,
        void_values: &prepass.void_values,
        style_ids: &prepass.style_ids,
        style_colors: &prepass.style_colors,
        plane_angle_to_radians: Some(prepass.meta.plane_angle_to_radians),
        material_element_ids: Some(prepass.material_element_ids.clone()),
        material_color_counts: Some(prepass.material_color_counts.clone()),
        material_colors_rgba: Some(prepass.material_colors.clone()),
    }, false);
    let mut hash = 0xcbf29ce484222325u64;
    for output in &outputs {
        fnv(&mut hash, format!("{} {:?} {:?}", output.id, output.meshes, output.finishes).as_bytes());
    }
    fnv(&mut hash, format!("{diagnostics:?}").as_bytes());
    let report = api.pipeline_diagnostics.lock().unwrap();
    fnv(&mut hash, format!("{} {}", report.refused_prepass_records, report.refused_input_elements).as_bytes());
    hash
}

#[inline(never)]
fn once_first_type_batch(content: &[u8]) -> u64 {
    let api = IfcAPI::new();
    let prepass = api.build_prepass_once_data(content);
    let first_type = prepass.complex_jobs.iter()
        .find(|job| job.3.is_subtype_of(IfcType::IfcTypeProduct))
        .map(|&(id, start, end, _)| vec![id, start as u32, end as u32])
        .unwrap_or_default();
    batch(&api, content, &prepass, &first_type)
}

fn worker_api(content: &[u8]) -> (IfcAPI, std::sync::Arc<ColumnarEntityIndex>) {
    let index = ColumnarEntityIndex::from_scan(content).unwrap();
    let api = IfcAPI::new();
    api.set_entity_index(index.ids(), index.starts(), index.lengths()).unwrap();
    // The streaming pre-pass's wire value for this content.
    let mut decoder = EntityDecoder::new(content);
    let flat = if ifc_lite_core::find_keyword(content, b"IFCMATERIALLAYERSET").is_some() {
        ifc_lite_geometry::MaterialLayerIndex::from_content(content, &mut decoder).to_flat()
    } else {
        ifc_lite_geometry::MaterialLayerFlat::default()
    };
    api.set_material_layer_index(&flat.element_ids, &flat.axis, &flat.layer_counts,
        &flat.direction_sense, &flat.offset, &flat.layer_material_ids, &flat.layer_thicknesses);
    api.set_merge_layers(true);
    (api, std::sync::Arc::new(index))
}

#[inline(never)]
fn worker_parts(api: &IfcAPI, content: &[u8], index: std::sync::Arc<ColumnarEntityIndex>) -> Vec<u32> {
    let mut decoder = EntityDecoder::with_arc_columnar_index(content, index);
    let mut parts: Vec<u32> = api.get_or_build_parts_to_skip(content, &mut decoder).iter().copied().collect();
    parts.sort_unstable();
    parts
}

#[test]
#[ignore = "C4-7b measurement harness; run through tests/evidence/c4-7b/measure.sh"]
fn c4_7b_measure() {
    let mode = std::env::var("C4_7B_MODE").expect("C4_7B_MODE");
    let fixture = std::env::var("C4_7B_FIXTURE").expect("C4_7B_FIXTURE");
    let content = std::fs::read(&fixture).unwrap_or_else(|err| panic!("{fixture}: {err}"));
    match mode.as_str() {
        "parts-setup" => drop(worker_api(&content)),
        "parts" => {
            let (api, index) = worker_api(&content);
            println!("C4_7B parts={}", worker_parts(&api, &content, index).len());
        }
        "once-setup" => {}
        "once" => println!("C4_7B once={:016x}", once_first_type_batch(&content)),
        "identity" => {
            for merge in [false, true] {
                let api = IfcAPI::new();
                api.set_merge_layers(merge);
                let prepass = api.build_prepass_once_data(&content);
                let jobs = jobs_wire(&prepass);
                println!("C4_7B_IDENTITY merge={merge} jobs={} hash={:016x}",
                    prepass.total_jobs(), batch(&api, &content, &prepass, &jobs));
            }
            let (api, index) = worker_api(&content);
            let parts = worker_parts(&api, &content, index);
            let mut hash = 0xcbf29ce484222325u64;
            fnv(&mut hash, format!("{parts:?}").as_bytes());
            println!("C4_7B_IDENTITY worker_parts={} hash={hash:016x}", parts.len());
        }
        other => panic!("unknown C4_7B_MODE {other}"),
    }
}
