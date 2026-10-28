// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The C4-0 observation legs (#7782): the browser once-path host and the
//! native pass, run over the same committed bytes.
//!
//! Every browser leg replays what `@ifc-lite/geometry`'s synchronous
//! once-path does (`packages/geometry/src/index.ts`): `buildPrePassOnce`,
//! `setStyleFinishes` with its finishes (`style-finishes.ts`), one
//! `processGeometryBatch` over every job with the wire's own `unitScale`,
//! `rtcOffset`, `needsShift` and `planeAngleToRadians`, then
//! `clearPrePassCache`. The legs only PACK those wire arguments: discovery,
//! meshing and diagnostic draining all run in the production
//! `build_prepass_once_data` and `produce_batch`, the same bodies the wasm
//! exports call. Nothing here re-implements a browser loop.

use super::super::ElementMeshOutput;
use crate::api::gpu_meshes::prepass_once::PrepassOnceData;
use crate::api::gpu_meshes::prepass_sharded::stream_meta_unit_scale;
use crate::api::IfcAPI;
use ifc_lite_geometry::GeometryDiagnostics;
use ifc_lite_processing::{process, MeshData, ProcessingRequest, ProcessingResult};

/// A committed fixture's bytes, by path relative to `rust/wasm-bindings`.
pub(super) fn fixture(path: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    std::fs::read(&path)
        .unwrap_or_else(|err| panic!("read committed fixture {}: {err}", path.display()))
}

/// `buildPrePassOnce` + `setStyleFinishes`, decoded to the native values the
/// JS typed arrays carry. The jobs array is filled by the one encoder
/// (`PrepassOnceData::write_jobs`) the `Uint32Array` is filled by.
pub(super) fn prepare(api: &IfcAPI, content: &[u8]) -> (PrepassOnceData, Vec<u32>) {
    let prepass = api.build_prepass_once_data(content);
    api.set_style_finishes(&prepass.style_ids, &prepass.style_finishes);
    let mut jobs = vec![u32::MAX; prepass.total_jobs() * 3];
    let mut written = 0usize;
    prepass.write_jobs(|index, value| {
        jobs[index as usize] = value;
        written += 1;
    });
    assert_eq!(
        written,
        jobs.len(),
        "the jobs encoder writes every word exactly once"
    );
    (prepass, jobs)
}

/// `processGeometryBatch`'s core over `jobs`, with the arguments the host reads
/// off the pre-pass object. Unarmed (the flat export's mode), so no don't-bake
/// occurrence may come back.
pub(super) fn run(
    api: &IfcAPI,
    content: &[u8],
    prepass: &PrepassOnceData,
    jobs: &[u32],
) -> (Vec<ElementMeshOutput>, GeometryDiagnostics) {
    let (rtc_x, rtc_y, rtc_z) = prepass.meta.frame.rtc_offset();
    let (outputs, diagnostics, occurrences) = api.produce_batch(
        content,
        jobs,
        stream_meta_unit_scale(&prepass.meta),
        rtc_x,
        rtc_y,
        rtc_z,
        prepass.meta.frame.needs_shift(),
        &prepass.void_keys,
        &prepass.void_counts,
        &prepass.void_values,
        &prepass.style_ids,
        &prepass.style_colors,
        Some(prepass.meta.plane_angle_to_radians),
        Some(prepass.material_element_ids.clone()),
        Some(prepass.material_color_counts.clone()),
        Some(prepass.material_colors.clone()),
        false,
    );
    assert!(
        occurrences.is_empty(),
        "an unarmed batch emits no don't-bake occurrence"
    );
    (outputs, diagnostics)
}

/// The per-worker accumulator, as `getPipelineDiagnostics` would serialize it
/// (camelCase keys), or `None` when no batch has been folded in since the
/// last load reset, the case the JS getter returns `undefined` for.
pub(super) fn pipeline_json(api: &IfcAPI) -> Option<serde_json::Value> {
    let diag = api
        .pipeline_diagnostics
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    (!diag.is_empty())
        .then(|| serde_json::to_value(&*diag).expect("PipelineDiagnostics serializes"))
}

/// A real batch drain and the accumulator immediately after it. Empty loads
/// have no entries; a warm replay retains both drains rather than hiding one.
pub(super) struct BatchObservation {
    pub jobs: Vec<u32>,
    pub planned_jobs: Vec<super::PlannedJob>,
    pub output_counts: [u64; 3],
    pub diagnostics: GeometryDiagnostics,
    pub pipeline: Option<serde_json::Value>,
}

pub(super) struct BrowserLoad {
    /// Split-only oracle: a fresh once-path API runs each cumulative job prefix.
    /// Never derived by subtracting or copying the split snapshots under test.
    pub cold_prefix_pipelines: Vec<Option<serde_json::Value>>,
    pub prepass: PrepassOnceData,
    pub outputs: Vec<ElementMeshOutput>,
    pub batches: Vec<BatchObservation>,
    pub pipeline: Option<serde_json::Value>,
}

impl BrowserLoad {
    pub fn meshes(&self) -> impl Iterator<Item = &MeshData> {
        self.outputs.iter().flat_map(|out| out.meshes.iter())
    }
}

/// Dispatch exactly as the synchronous load host does: no jobs means no
/// processGeometryBatch call, no drain, and no PipelineDiagnostics object.
fn dispatch(
    api: &IfcAPI,
    content: &[u8],
    prepass: &PrepassOnceData,
    jobs: &[u32],
    batches: &mut Vec<BatchObservation>,
) -> Vec<ElementMeshOutput> {
    if jobs.is_empty() {
        assert!(
            pipeline_json(api).is_none(),
            "zero-job load has no batch diagnostics"
        );
        assert_eq!(api.pipeline_diagnostics.lock().unwrap().batches, 0);
        return Vec::new();
    }
    super::JOB_TRACE.with_borrow_mut(|slot| *slot = Some(Vec::new()));
    let (outputs, diagnostics) = run(api, content, prepass, jobs);
    let planned_jobs = super::JOB_TRACE.with_borrow_mut(|slot| slot.take().unwrap());
    let pipeline = pipeline_json(api);
    assert_eq!(
        pipeline.as_ref().unwrap()["batches"],
        batches.len() as u64 + 1
    );
    let output_counts = [
        outputs.len() as u64,
        outputs.iter().map(|o| o.meshes.len() as u64).sum(),
        outputs
            .iter()
            .flat_map(|o| &o.meshes)
            .map(|m| (m.indices.len() / 3) as u64)
            .sum(),
    ];
    for (i, key) in ["elementCount", "meshCount", "triangleCount"]
        .iter()
        .enumerate()
    {
        let expected = output_counts[i] + batches.iter().map(|b| b.output_counts[i]).sum::<u64>();
        assert_eq!(
            pipeline.as_ref().unwrap()[*key],
            expected,
            "accumulator {key} matches returned outputs"
        );
    }
    batches.push(BatchObservation {
        planned_jobs,
        output_counts,
        jobs: jobs.chunks_exact(3).map(|job| job[0]).collect(),
        diagnostics,
        pipeline,
    });
    outputs
}

pub(super) fn browser_cold(content: &[u8]) -> BrowserLoad {
    let api = IfcAPI::new();
    let load = browser_load(&api, content);
    api.clear_pre_pass_cache();
    load
}

fn browser_load(api: &IfcAPI, content: &[u8]) -> BrowserLoad {
    let (prepass, jobs) = prepare(api, content);
    let mut batches = Vec::new();
    let outputs = dispatch(api, content, &prepass, &jobs, &mut batches);
    let pipeline = pipeline_json(api);
    BrowserLoad {
        prepass,
        outputs,
        batches,
        pipeline,
        cold_prefix_pipelines: Vec::new(),
    }
}

/// Replay the same nonempty wire without clearing any worker caches. The
/// outputs are the warm leg; both cold and warm diagnostics remain observable.
pub(super) fn browser_warm(content: &[u8]) -> BrowserLoad {
    let api = IfcAPI::new();
    let (prepass, jobs) = prepare(&api, content);
    let mut batches = Vec::new();
    dispatch(&api, content, &prepass, &jobs, &mut batches);
    let outputs = dispatch(&api, content, &prepass, &jobs, &mut batches);
    let pipeline = pipeline_json(&api);
    api.clear_pre_pass_cache();
    BrowserLoad {
        prepass,
        outputs,
        batches,
        pipeline,
        cold_prefix_pipelines: Vec::new(),
    }
}

/// One job per real batch, preserving every drain and accumulator snapshot.
pub(super) fn browser_split(content: &[u8]) -> BrowserLoad {
    let api = IfcAPI::new();
    let (prepass, jobs) = prepare(&api, content);
    let mut batches = Vec::new();
    let mut outputs = Vec::new();
    for job in jobs.chunks_exact(3) {
        outputs.extend(dispatch(&api, content, &prepass, job, &mut batches));
    }
    let pipeline = pipeline_json(&api);
    assert_eq!(
        api.pipeline_diagnostics.lock().unwrap().batches,
        (jobs.len() / 3) as u64
    );
    api.clear_pre_pass_cache();
    // Observe references AFTER the split leg, so no extra API activity is
    // interleaved with the lifecycle under test. Small committed fixtures only.
    let mut cold_prefix_pipelines = Vec::new();
    for end in (3..=jobs.len()).step_by(3) {
        let reference_api = IfcAPI::new();
        let (reference_prepass, reference_jobs) = prepare(&reference_api, content);
        assert_eq!(
            reference_jobs, jobs,
            "fresh prepass preserves the attempted wire"
        );
        let mut reference_batches = Vec::new();
        dispatch(
            &reference_api,
            content,
            &reference_prepass,
            &reference_jobs[..end],
            &mut reference_batches,
        );
        cold_prefix_pipelines.push(pipeline_json(&reference_api));
        reference_api.clear_pre_pass_cache();
    }
    BrowserLoad {
        prepass,
        outputs,
        batches,
        pipeline,
        cold_prefix_pipelines,
    }
}

/// Keep both load observations: the caller can check the predecessor as well
/// as reset isolation on the target (including a zero-job target).
pub(super) fn browser_reloaded(previous: &[u8], content: &[u8]) -> (BrowserLoad, BrowserLoad) {
    let api = IfcAPI::new();
    let previous = browser_load(&api, previous);
    api.clear_pre_pass_cache();
    let target = browser_load(&api, content);
    api.clear_pre_pass_cache();
    (previous, target)
}

/// Observe the native discovery result using the public selection request,
/// whose geometry_entity_count is taken after discovery and selection. This
/// reuses the real scanner/planner, including jobs that emit no meshes; it
/// does not reconstruct native discovery from a second IFC parser.
/// Candidates are the union of browser discovery and native output ids. The
/// total-count assertion rejects an unobserved native-only, non-drawing job.
pub(super) fn native_jobs(
    content: &[u8],
    native: &ProcessingResult,
    browser: &PrepassOnceData,
) -> std::collections::BTreeMap<u32, usize> {
    let candidates: std::collections::BTreeSet<u32> = browser
        .simple_jobs
        .iter()
        .chain(&browser.complex_jobs)
        .map(|j| j.0)
        .chain(native.meshes.iter().map(|m| m.express_id))
        .collect();
    let jobs: std::collections::BTreeMap<_, _> = candidates
        .into_iter()
        .filter_map(|id| {
            let result = native_selected(content, id);
            let count = result.metadata.geometry_entity_count;
            (count > 0).then_some((id, count))
        })
        .collect();
    assert_eq!(
        jobs.values().sum::<usize>(),
        native.metadata.geometry_entity_count,
        "candidate probes must account for every native production job"
    );
    jobs
}

pub(super) fn native_selected(content: &[u8], id: u32) -> ProcessingResult {
    let request = ProcessingRequest::full_pass().ids(Some(std::sync::Arc::new([id].into())));
    process(content, &request, &mut ())
}

/// Mesh express ids drawn by the public flat and partitioned exports for the
/// same wire, each on a fresh API (direct API probes, not load-host legs): `(flat, partitioned_flat, shard_instances,
/// reported_instanced_occurrences)`. Both adapters consume one
/// `produce_batch`; the partition may move a mesh into the shard but must not
/// lose or invent one.
pub(super) fn adapter_ids(content: &[u8]) -> (Vec<u32>, Vec<u32>, Vec<u32>, usize) {
    let flat_api = IfcAPI::new();
    let (prepass, jobs) = prepare(&flat_api, content);
    let (rtc_x, rtc_y, rtc_z) = prepass.meta.frame.rtc_offset();
    let unit_scale = stream_meta_unit_scale(&prepass.meta);
    let needs_shift = prepass.meta.frame.needs_shift();
    let flat = flat_api.process_geometry_batch(
        content,
        &jobs,
        unit_scale,
        rtc_x,
        rtc_y,
        rtc_z,
        needs_shift,
        &prepass.void_keys,
        &prepass.void_counts,
        &prepass.void_values,
        &prepass.style_ids,
        &prepass.style_colors,
        Some(prepass.meta.plane_angle_to_radians),
        Some(prepass.material_element_ids.clone()),
        Some(prepass.material_color_counts.clone()),
        Some(prepass.material_colors.clone()),
    );
    let collection_ids = |collection: &crate::zero_copy::MeshCollection| -> Vec<u32> {
        (0..collection.len())
            .map(|i| collection.get(i).expect("index below len").express_id())
            .collect()
    };
    let flat_ids = collection_ids(&flat);

    let partition_api = IfcAPI::new();
    let (prepass, jobs) = prepare(&partition_api, content);
    let mut partitioned = partition_api.process_geometry_batch_partitioned(
        content,
        &jobs,
        unit_scale,
        rtc_x,
        rtc_y,
        rtc_z,
        needs_shift,
        &prepass.void_keys,
        &prepass.void_counts,
        &prepass.void_values,
        &prepass.style_ids,
        &prepass.style_colors,
        Some(prepass.meta.plane_angle_to_radians),
        Some(prepass.material_element_ids.clone()),
        Some(prepass.material_color_counts.clone()),
        Some(prepass.material_colors.clone()),
    );
    let reported = partitioned.instanced_occurrences();
    let partition_flat = collection_ids(
        &partitioned
            .take_meshes()
            .expect("a fresh result holds its meshes"),
    );
    let shard = partitioned.take_shard();
    let shard_ids = if shard.is_empty() {
        Vec::new()
    } else {
        ifc_lite_geometry::decode_instanced(&shard)
            .expect("the partition's shard decodes")
            .instances
            .iter()
            .map(|instance| instance.entity_id)
            .collect()
    };
    (flat_ids, partition_flat, shard_ids, reported)
}

/// The native pass the server, CLI and exporters run: one chunk, no
/// instancing, every mesh retained.
pub(super) fn native(content: &[u8]) -> ProcessingResult {
    let result = process(content, &ProcessingRequest::full_pass(), &mut ());
    assert!(
        result.instances.is_empty(),
        "the flat native request emits no instance records"
    );
    result
}
