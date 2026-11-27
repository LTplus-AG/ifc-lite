// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Byte identity of the out-of-core batch path: the same jobs, meshed
//! from a sparse arena fed by simulated range reads, must produce exactly the
//! element outputs the whole-file path produces. `IFC_SPARSE_PARITY_FILES`
//! (path-separator list) adds models that are not committed.

use crate::api::gpu_meshes::batch_wire::BatchWire;
use crate::api::gpu_meshes::sparse_facts::SparseFacts;
use crate::api::IfcAPI;
use ifc_lite_core::{ColumnarEntityIndex, EntityDecoder, EntityScanner};
use std::hash::Hasher;
use std::sync::Arc;

struct Prepared {
    api: IfcAPI,
    jobs: Vec<u32>,
    pre: crate::api::gpu_meshes::prepass_once::PrepassOnceData,
    index: Arc<ColumnarEntityIndex>,
    instance_plan: Vec<u32>,
}

/// Run the whole-file pre-pass and capture what a streaming pre-pass would
/// ship to workers.
fn prepare(source: &[u8]) -> Prepared {
    let api = IfcAPI::new();
    let pre = api.build_prepass_once_data(source);
    let mut jobs = vec![0u32; pre.total_jobs() * 3];
    pre.write_jobs(|i, v| jobs[i as usize] = v);
    let index = api.content.cached_entity_index.lock().unwrap().clone().expect("pre-pass index");
    // The don't-bake plan only travels on the streaming wire: derive it the
    // same way so both sides are armed like a worker is.
    let mut decoder = EntityDecoder::with_arc_columnar_index(source, index.clone()).with_strict_reals();
    let scanned = crate::api::styling::combined_pre_pass(source, &mut decoder);
    let columns = crate::api::gpu_meshes::prepass_columns::PrepassColumns::build(
        source,
        &scanned.prepass_spans,
        &scanned.mapped_item_spans,
        crate::api::content_lazy::has_material_layer_set(source),
        &mut decoder,
    );
    let instance_plan = columns.type_plan.browser_instance_sources();
    api.set_mapped_instance_plan(&instance_plan);
    Prepared { api, jobs, pre, index, instance_plan }
}

fn wire<'a>(pre: &'a crate::api::gpu_meshes::prepass_once::PrepassOnceData, jobs: &'a [u32]) -> BatchWire<'a> {
    let (rtc_x, rtc_y, rtc_z) = pre.meta.frame.rtc_offset();
    BatchWire {
        jobs_flat: jobs,
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

/// Order-sensitive digest of everything a batch hands to the output adapters.
fn digest(out: &crate::api::gpu_meshes::batch_output::BatchOutput, into: &mut rustc_hash::FxHasher) -> (usize, usize) {
    let (outputs, _diag, occurrences) = out;
    let (mut meshes, mut triangles) = (0, 0);
    for element in outputs {
        into.write_u32(element.id);
        into.write(format!("{:?}{:?}{:?}", element.geometry_hash, element.geometry_aabb, element.finishes).as_bytes());
        for mesh in &element.meshes {
            meshes += 1;
            triangles += mesh.indices.len() / 3;
            into.write(format!("{mesh:?}").as_bytes());
        }
    }
    for occurrence in occurrences {
        into.write_u32(occurrence.entity_id);
        into.write(
            format!(
                "{:?}{:?}{:?}{:?}{:?}",
                occurrence.color, occurrence.rep_identity, occurrence.world_transform, occurrence.geometry_item_id, occurrence.finish
            )
            .as_bytes(),
        );
    }
    (meshes, triangles)
}

struct SparseRun {
    api: IfcAPI,
    /// Rounds of range reads, records read and bytes read, for the report.
    rounds: usize,
    retries: usize,
}

fn sparse_api(source: &[u8], full: &Prepared) -> SparseRun {
    let mut facts = SparseFacts::default();
    let mut scanner = EntityScanner::new(source);
    while let Some((id, kw, start, end)) = scanner.next_entity() {
        facts.observe(source, id, kw, start, end);
    }
    let api = IfcAPI::new();
    api.sparse_begin(facts.preamble(source, |id| full.index.lookup(id)), 1 << 20);
    api.sparse_set_inverse_edges(&facts.inverse_targets, &facts.inverse_referrers);
    // What `set-prepass-columns` installs on a worker.
    let ids = |slot: &std::sync::Mutex<Option<Arc<rustc_hash::FxHashSet<u32>>>>| -> Vec<u32> {
        slot.lock().unwrap().as_ref().map(|set| set.iter().copied().collect()).unwrap_or_default()
    };
    api.set_referenced_repmaps(&ids(&full.api.content.cached_referenced_repmaps));
    api.set_instantiated_type_ids(&ids(&full.api.content.cached_instantiated_type_ids));
    api.set_mapped_instance_plan(&full.instance_plan);
    let layers = full.api.content.cached_material_layer_index.lock().unwrap().clone();
    *api.content.cached_material_layer_index.lock().unwrap() = layers;
    SparseRun { api, rounds: 0, retries: 0 }
}

impl SparseRun {
    /// The host side of a batch: read what the walk asks for until it asks for
    /// nothing, exactly as the worker does with range reads.
    fn fetch(&mut self, source: &[u8], index: &ColumnarEntityIndex, roots: &[u32]) {
        let mut walk = roots.to_vec();
        loop {
            let missing = self.api.sparse_expand(&walk, u32::MAX);
            if missing.is_empty() {
                return;
            }
            self.rounds += 1;
            let mut placed: Vec<(usize, u32, usize)> = Vec::with_capacity(missing.len());
            let mut absent = Vec::new();
            for &id in &missing {
                match index.lookup(id) {
                    Some((start, end)) => placed.push((start, id, end - start)),
                    None => absent.push(id),
                }
            }
            // In file order, as the worker's read plan installs them: the arena keeps install order,
            // and a scan of it (the colour-map index) takes the first record it meets.
            placed.sort_unstable_by_key(|&(start, _, _)| start);
            let mut spans = Vec::with_capacity(placed.len() * 3);
            for (start, id, length) in placed {
                spans.extend_from_slice(&[id, start as u32, length as u32]);
            }
            self.api.sparse_install(&spans, source);
            self.api.sparse_mark_absent(&absent);
            walk = missing;
        }
    }

    fn batch(
        &mut self,
        source: &[u8],
        full: &Prepared,
        jobs: &[u32],
    ) -> crate::api::gpu_meshes::batch_output::BatchOutput {
        // Roots: the jobs and the openings that cut them.
        let mut roots: Vec<u32> = jobs.chunks_exact(3).map(|job| job[0]).collect();
        let voids = ifc_lite_processing::prepass::voids_from_flat(
            &full.pre.void_keys,
            &full.pre.void_counts,
            &full.pre.void_values,
        );
        for job in jobs.chunks_exact(3) {
            if let Some(openings) = voids.get(&job[0]) {
                roots.extend(openings.iter().copied());
            }
        }
        self.fetch(source, &full.index, &roots);
        loop {
            let (bytes, sparse_jobs) = self.api.sparse_batch_inputs(jobs).expect("session");
            let out = self.api.produce_batch(&bytes, &wire(&full.pre, &sparse_jobs), true);
            self.api.end_sparse_batch();
            let misses: Vec<u32> = self
                .api
                .sparse_take_misses()
                .into_iter()
                .filter(|&id| full.index.lookup(id).is_some())
                .collect();
            if misses.is_empty() {
                return out;
            }
            // The walk missed a dependency the file does hold: install it and
            // run the batch again from clean derived state.
            self.retries += 1;
            self.fetch(source, &full.index, &misses);
            self.api.sparse_invalidate_derived();
        }
    }
}

/// `(meshes, triangles, digest)` of the whole model on both paths.
fn compare(name: &str, source: &[u8], batch_jobs: usize, arena_budget: usize) {
    let full = prepare(source);
    let mut sparse = sparse_api(source, &full);
    let (mut full_hash, mut sparse_hash) = (rustc_hash::FxHasher::default(), rustc_hash::FxHasher::default());
    let (mut full_counts, mut sparse_counts) = ((0, 0), (0, 0));
    let mut peak_arena = 0usize;
    for (batch, jobs) in full.jobs.chunks(batch_jobs * 3).enumerate() {
        let expected = full.api.produce_batch(source, &wire(&full.pre, jobs), true);
        let (m, t) = digest(&expected, &mut full_hash);
        full_counts = (full_counts.0 + m, full_counts.1 + t);

        let actual = sparse.batch(source, &full, jobs);
        let (m, t) = digest(&actual, &mut sparse_hash);
        sparse_counts = (sparse_counts.0 + m, sparse_counts.1 + t);
        assert_eq!(
            full_hash.finish(),
            sparse_hash.finish(),
            "{name}: batch {batch} diverged (full {full_counts:?} vs sparse {sparse_counts:?})"
        );
        let arena = sparse.api.sparse_stats()[0] as usize;
        peak_arena = peak_arena.max(arena);
        if arena > arena_budget {
            sparse.api.sparse_reset();
        }
    }
    assert_eq!(full_counts, sparse_counts, "{name}");
    let stats = sparse.api.sparse_stats();
    println!(
        "sparse-parity {name}: bytes={} jobs={} meshes={} triangles={} digest={:016x} \
         peakArena={} installedBytes={} installedRecords={} resets={} rounds={} retries={}",
        source.len(),
        full.jobs.len() / 3,
        full_counts.0,
        full_counts.1,
        full_hash.finish(),
        peak_arena,
        stats[3],
        stats[4],
        stats[5],
        sparse.rounds,
        sparse.retries,
    );
}

fn committed_fixtures() -> Vec<std::path::PathBuf> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../processing/tests/fixtures");
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .expect("processing fixtures")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "ifc"))
        .collect();
    files.sort();
    files
}

#[test]
fn sparse_batches_are_byte_identical_on_the_committed_fixtures() {
    let fixtures = committed_fixtures();
    assert!(fixtures.len() >= 10, "the fixture corpus is the evidence: {} files", fixtures.len());
    for path in fixtures {
        let source = std::fs::read(&path).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        // Small batches and a zero budget: every batch starts from the bare
        // preamble, so nothing is hidden by a record an earlier batch left.
        compare(&name, &source, 4, 0);
        compare(&name, &source, 64, usize::MAX);
    }
}

/// Models that are not committed (`pnpm fixtures`), named by the environment.
#[test]
fn sparse_batches_are_byte_identical_on_named_models() {
    let Some(list) = std::env::var_os("IFC_SPARSE_PARITY_FILES") else {
        println!("IFC_SPARSE_PARITY_FILES not set: skipped");
        return;
    };
    let budget = std::env::var("IFC_SPARSE_PARITY_BUDGET_MB")
        .ok()
        .and_then(|mb| mb.parse::<usize>().ok())
        .map_or(usize::MAX, |mb| mb * 1024 * 1024);
    let mut diverged = Vec::new();
    for path in std::env::split_paths(&list) {
        let source = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        // One model at a time, so one divergence does not hide the others.
        let run = std::panic::catch_unwind(|| compare(&name, &source, 256, budget));
        if run.is_err() {
            diverged.push(name);
        }
    }
    assert!(diverged.is_empty(), "sparse output diverged on: {diverged:?}");
}

/// Per-job reference closure sizes: each job fetched alone from the bare
/// preamble (so nothing is shared), against the union the whole model needs.
fn closure_distribution(name: &str, source: &[u8]) {
    let full = prepare(source);
    let mut sparse = sparse_api(source, &full);
    let base = sparse.api.sparse_stats()[0];
    let voids = ifc_lite_processing::prepass::voids_from_flat(&full.pre.void_keys, &full.pre.void_counts, &full.pre.void_values);
    let (mut bytes, mut records): (Vec<u64>, Vec<u64>) = (Vec::new(), Vec::new());
    for job in full.jobs.chunks_exact(3) {
        sparse.api.sparse_reset();
        let before = sparse.api.sparse_stats();
        let mut roots = vec![job[0]];
        if let Some(openings) = voids.get(&job[0]) {
            roots.extend(openings.iter().copied());
        }
        sparse.fetch(source, &full.index, &roots);
        let after = sparse.api.sparse_stats();
        bytes.push((after[3] - before[3]) as u64);
        records.push((after[4] - before[4]) as u64);
    }
    // The union: every job into one arena, nothing dropped.
    let mut union = sparse_api(source, &full);
    let all: Vec<u32> = full.jobs.chunks_exact(3).map(|job| job[0]).chain(full.pre.void_values.iter().copied()).collect();
    union.fetch(source, &full.index, &all);
    let union_stats = union.api.sparse_stats();
    bytes.sort_unstable();
    records.sort_unstable();
    let pct = |v: &[u64], p: f64| v.get(((v.len() as f64 - 1.0) * p).round() as usize).copied().unwrap_or(0);
    let sum: u64 = bytes.iter().sum();
    println!(
        "sparse-closure {name}: fileBytes={} jobs={} preambleBytes={base} unionBytes={} unionRecords={} \
         sumPerJobBytes={sum} bytes[p50,p90,p99,max]=[{},{},{},{}] records[p50,p90,p99,max]=[{},{},{},{}] rounds={}",
        source.len(),
        bytes.len(),
        union_stats[3],
        union_stats[4],
        pct(&bytes, 0.5), pct(&bytes, 0.9), pct(&bytes, 0.99), pct(&bytes, 1.0),
        pct(&records, 0.5), pct(&records, 0.9), pct(&records, 0.99), pct(&records, 1.0),
        union.rounds,
    );
}

#[test]
fn sparse_closure_distribution_of_named_models() {
    let Some(list) = std::env::var_os("IFC_SPARSE_CLOSURE_FILES") else {
        println!("IFC_SPARSE_CLOSURE_FILES not set: skipped");
        return;
    };
    for path in std::env::split_paths(&list) {
        let source = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        closure_distribution(&path.file_name().unwrap().to_string_lossy(), &source);
    }
}
