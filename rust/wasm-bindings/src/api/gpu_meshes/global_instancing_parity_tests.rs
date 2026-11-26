// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The global instance plan against the flat reference, on committed models,
//! through the real partitioned batch over several worker and batch splits.
//!
//! Each split is simulated natively: one `IfcAPI` per worker (its own caches),
//! jobs dealt round-robin, `processGeometryBatchPartitioned` per batch, every
//! shard decoded by the existing IFNS decoder and joined by its key trailer.
//! The reference is the flat batch (`processGeometryBatch`), hashing on as the
//! viewer runs it. Asserted:
//! - geometry fingerprints equal the reference's for EVERY element, instanced
//!   or not (model compare reads them);
//! - every element is present with the reference's triangle count, colours
//!   and world box (within f32 instance-transform precision);
//! - meshes that stay flat are byte-identical to the reference's;
//! - the template set is the same at every split.

use super::batch_wire::{BatchSource, BatchWire};
use super::global_instancing::KEY_TRAILER_MAGIC;
use super::global_key_plan::{build_key_plan, voided_hosts};
use super::global_plan::GLOBAL_INSTANCE_GATE;
use super::prepass_once::PrepassOnceData;
use crate::api::IfcAPI;
use std::collections::{BTreeMap, BTreeSet};

const HASH_TOLERANCE: f64 = 1e-3;

struct Element {
    tris: usize,
    colours: BTreeSet<[u8; 4]>,
    min: [f64; 3],
    max: [f64; 3],
    flat: Vec<(Vec<u8>, Vec<u32>)>,
    instanced: bool,
}

impl Default for Element {
    fn default() -> Self {
        Self {
            tris: 0,
            colours: BTreeSet::new(),
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
            flat: Vec::new(),
            instanced: false,
        }
    }
}

impl Element {
    fn add(&mut self, p: [f64; 3]) {
        self.min = std::array::from_fn(|k| self.min[k].min(p[k]));
        self.max = std::array::from_fn(|k| self.max[k].max(p[k]));
    }
}

struct Run {
    fingerprints: BTreeMap<u32, u64>,
    elements: BTreeMap<u32, Element>,
    keys: BTreeSet<u64>,
    instances: usize,
}

struct Prepared {
    pre: PrepassOnceData,
    jobs: Vec<[u32; 3]>,
    sources: Vec<u32>,
    counts: Vec<u32>,
    job_plan: Vec<u32>,
}

fn prepare(content: &[u8]) -> Prepared {
    let api = IfcAPI::new();
    let pre = api.build_prepass_once_data(content);
    let jobs: Vec<[u32; 3]> =
        pre.simple_jobs.iter().chain(&pre.complex_jobs).map(|&(id, s, e, _)| [id, s as u32, e as u32]).collect();
    let index = api.content.cached_entity_index.lock().unwrap().clone().expect("index");
    let mut decoder = ifc_lite_core::EntityDecoder::with_arc_columnar_index(content, index.clone());
    let router = ifc_lite_geometry::GeometryRouter::new();
    let keys: Vec<Option<u128>> = jobs
        .iter()
        .map(|j| decoder.decode_by_id(j[0]).ok().and_then(|e| router.geometry_item_key(&e, &mut decoder)))
        .collect();
    let mut void_rels = Vec::new();
    let mut scanner = ifc_lite_core::EntityScanner::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if ifc_lite_core::keyword_eq(name, "IFCRELVOIDSELEMENT") {
            void_rels.push((id, start, end));
        }
    }
    let ids: Vec<u32> = jobs.iter().map(|j| j[0]).collect();
    let plan = build_key_plan(&ids, &keys, &voided_hosts(content, &void_rels), GLOBAL_INSTANCE_GATE);
    let mut decoder = ifc_lite_core::EntityDecoder::with_arc_columnar_index(content, index);
    let types = ifc_lite_processing::discovery::TypeGeometryPlan::from_file(
        content,
        &mut decoder,
        ifc_lite_processing::element::TypeGeometryMode::EmitTagged,
    );
    Prepared { sources: types.browser_instance_sources(), counts: types.browser_instance_counts(), pre, jobs, job_plan: plan.job_plan }
}

fn wire<'a>(jobs_flat: &'a [u32], pre: &'a PrepassOnceData) -> BatchWire<'a> {
    let (rtc_x, rtc_y, rtc_z) = pre.meta.frame.rtc_offset();
    BatchWire {
        jobs_flat,
        unit_scale: pre.meta.length_unit_scale,
        rtc_x,
        rtc_y,
        rtc_z,
        needs_shift: pre.meta.frame.needs_shift(),
        void_keys: &pre.void_keys,
        void_counts: &pre.void_counts,
        void_values: &pre.void_values,
        style_ids: &pre.style_ids,
        style_colors: &pre.style_colors,
        plane_angle_to_radians: Some(pre.meta.plane_angle_to_radians),
        material_element_ids: Some(pre.material_element_ids.clone()),
        material_color_counts: Some(pre.material_color_counts.clone()),
        material_colors_rgba: Some(pre.material_colors.clone()),
    }
}

fn colour(c: [f32; 4]) -> [u8; 4] {
    c.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
}

/// Fold one flat collection into the run (positions Y-up → native Z-up).
fn fold_flat(run: &mut Run, collection: &crate::zero_copy::MeshCollection) {
    run.fingerprints.extend(collection.test_fingerprints());
    for (id, pos, idx, c, origin, _) in collection.test_meshes() {
        let e = run.elements.entry(id).or_default();
        e.colours.insert(colour(c));
        e.tris += idx.len() / 3;
        e.flat.push((pos.iter().flat_map(|v| v.to_le_bytes()).collect(), idx.to_vec()));
        for v in pos.chunks_exact(3) {
            let y = [origin[0] + v[0] as f64, origin[1] + v[1] as f64, origin[2] + v[2] as f64];
            e.add([y[0], -y[2], y[1]]);
        }
    }
}

fn key_trailer(bytes: &[u8], templates: usize) -> Vec<u64> {
    let at = bytes.len() - 8 - templates * 8;
    let w = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    assert_eq!(w(at), KEY_TRAILER_MAGIC, "every global shard carries the key trailer");
    (0..templates).map(|i| ((w(at + 8 + i * 8) as u64) << 32) | w(at + 12 + i * 8) as u64).collect()
}

/// Join shards by key (first definition wins) and expand every instance.
fn fold_shards(run: &mut Run, shards: &[Vec<u8>]) {
    let mut defs: BTreeMap<u64, ifc_lite_geometry::DecodedTemplate> = BTreeMap::new();
    let decoded: Vec<_> = shards.iter().map(|b| (ifc_lite_geometry::decode_instanced(b).expect("IFNS"), b)).collect();
    for (d, bytes) in &decoded {
        for (t, key) in d.templates.iter().zip(key_trailer(bytes, d.templates.len())) {
            assert!(!t.indices.is_empty(), "every keyed record carries its geometry");
            defs.entry(key).or_insert_with(|| t.clone());
        }
    }
    for (d, bytes) in &decoded {
        let keys = key_trailer(bytes, d.templates.len());
        for inst in &d.instances {
            let key = keys[inst.template_index as usize];
            run.keys.insert(key);
            run.instances += 1;
            let t = &defs[&key];
            let e = run.elements.entry(inst.entity_id).or_default();
            e.instanced = true;
            e.colours.insert(colour(inst.color));
            e.tris += t.indices.len() / 3;
            let m = inst.transform.map(|v| v as f64);
            for v in t.positions.chunks_exact(3) {
                let q: [f64; 3] = std::array::from_fn(|k| t.origin[k] + v[k] as f64);
                e.add(std::array::from_fn(|r| m[4 * r] * q[0] + m[4 * r + 1] * q[1] + m[4 * r + 2] * q[2] + m[4 * r + 3]));
            }
        }
    }
}

fn reference(content: &[u8], p: &Prepared) -> Run {
    let api = IfcAPI::new();
    api.build_prepass_once_data(content);
    api.set_compute_geometry_hashes(Some(HASH_TOLERANCE));
    let mut run = Run { fingerprints: BTreeMap::new(), elements: BTreeMap::new(), keys: BTreeSet::new(), instances: 0 };
    for batch in p.jobs.chunks(64) {
        let flat: Vec<u32> = batch.iter().flatten().copied().collect();
        fold_flat(&mut run, &api.batch_flat(BatchSource::Borrowed(content), wire(&flat, &p.pre)));
    }
    run
}

fn global(content: &[u8], p: &Prepared, workers: usize, batch: usize) -> Run {
    let ids: Vec<u32> = p.jobs.iter().map(|j| j[0]).collect();
    let apis: Vec<IfcAPI> = (0..workers)
        .map(|_| {
            let api = IfcAPI::new();
            api.build_prepass_once_data(content);
            api.set_compute_geometry_hashes(Some(HASH_TOLERANCE));
            api.set_global_instance_plan(&p.sources, &p.counts);
            api.add_global_key_plan(&ids, &p.job_plan);
            api
        })
        .collect();
    let mut run = Run { fingerprints: BTreeMap::new(), elements: BTreeMap::new(), keys: BTreeSet::new(), instances: 0 };
    let mut shards = Vec::new();
    for (w, api) in apis.iter().enumerate() {
        let mine: Vec<[u32; 3]> = p.jobs.iter().skip(w).step_by(workers).copied().collect();
        for slice in mine.chunks(batch) {
            let flat: Vec<u32> = slice.iter().flatten().copied().collect();
            let mut part = api.batch_partitioned(BatchSource::Borrowed(content), wire(&flat, &p.pre));
            fold_flat(&mut run, &part.take_meshes().expect("meshes"));
            let shard = part.take_shard();
            if !shard.is_empty() {
                shards.push(shard);
            }
        }
    }
    fold_shards(&mut run, &shards);
    run
}

fn assert_matches_reference(name: &str, reference: &Run, got: &Run) {
    assert_eq!(got.fingerprints, reference.fingerprints, "{name}: every fingerprint is the reference's");
    let ids: Vec<&u32> = got.elements.keys().collect();
    assert_eq!(ids, reference.elements.keys().collect::<Vec<_>>(), "{name}: same elements");
    for (id, r) in &reference.elements {
        let g = &got.elements[id];
        assert_eq!(g.tris, r.tris, "{name}: #{id} triangle count");
        assert_eq!(g.colours, r.colours, "{name}: #{id} colours");
        for k in 0..3 {
            let d = (g.min[k] - r.min[k]).abs().max((g.max[k] - r.max[k]).abs());
            assert!(d < 1e-3, "{name}: #{id} world box moved {d} m on axis {k}");
        }
        if !g.instanced {
            let mut a = g.flat.clone();
            let mut b = r.flat.clone();
            a.sort();
            b.sort();
            assert!(a == b, "{name}: #{id} stays flat and byte-identical");
        }
    }
}

fn check(path: &str, min_instances: usize) {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    let content = std::fs::read(&file).unwrap_or_else(|err| panic!("read fixture {}: {err}", file.display()));
    let p = prepare(&content);
    if p.pre.meta.frame.needs_shift() {
        // The plan never arms on a shifted model: the per-batch path keeps it.
        eprintln!("{path}: RTC-shifted, global plan not armed");
        return;
    }
    let reference = reference(&content, &p);
    let one = global(&content, &p, 1, 512);
    assert!(one.instances >= min_instances, "{path}: {} instances under the plan", one.instances);
    eprintln!("{path}: {} elements, {} instances, {} templates", reference.elements.len(), one.instances, one.keys.len());
    assert_matches_reference(&format!("{path} 1x512"), &reference, &one);
    for (workers, batch) in [(3, 7), (4, 1)] {
        let split = global(&content, &p, workers, batch);
        assert_matches_reference(&format!("{path} {workers}x{batch}"), &reference, &split);
        assert_eq!(split.keys, one.keys, "{path} {workers}x{batch}: the template set does not depend on the split");
        assert_eq!(split.instances, one.instances, "{path} {workers}x{batch}: nor does what instances");
    }
}

#[test]
fn global_plan_matches_the_flat_reference_on_fzk_haus() {
    check("../../apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc", 8);
}

#[test]
fn global_plan_matches_the_flat_reference_on_mapped_instances() {
    check("../geometry/tests/fixtures/mapped_instances_synthetic.ifc", 8);
}

/// Heavy real models, by hand: `IFC_LITE_GLOBAL_PLAN_MODELS=a.ifc:b.ifc cargo test -p ifc-lite-wasm
/// --lib global_plan_matches_the_flat_reference_on_listed_models -- --ignored --nocapture`.
#[test]
#[ignore = "heavy models from IFC_LITE_GLOBAL_PLAN_MODELS"]
fn global_plan_matches_the_flat_reference_on_listed_models() {
    let list = std::env::var("IFC_LITE_GLOBAL_PLAN_MODELS").expect("IFC_LITE_GLOBAL_PLAN_MODELS");
    for path in list.split(':').filter(|p| !p.is_empty()) {
        check(path, 0);
    }
}
