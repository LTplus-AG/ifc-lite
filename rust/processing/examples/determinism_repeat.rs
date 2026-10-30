// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Repeat-import determinism probe: process one file N times in a single
//! process and report which meshes differ between runs, and in which buffer.
//!
//! Identical input must give identical vertex and index buffers every run, and
//! the counterexamples are thread-order dependent (a shared cache filled in a
//! different order), so they only show up on a repeated in-process import. The
//! report names the express ids that moved and the per-mesh digests they moved
//! between: `nrm` alone changing is a different defect from `pos` changing.
//!
//! ```shell
//! IFC_LITE_DET_FILE=<path> IFC_LITE_DET_RUNS=20 \
//!   cargo run --profile server-release --example determinism_repeat -p ifc-lite-processing
//! ```
//!
//! `server-release` because the workspace release profile aborts on panic.
//! Exits 1 when any mesh moved. Set `IFC_LITE_DET_PRINT=1` to also print every
//! mesh's digests, so two BUILDS can be diffed against each other: which
//! buffers moved, not just whether something did.
//!
//! `perf_probe --fingerprint` answers "did anything move" over the same
//! repeated imports with one digest per run. This localizes the answer.

use std::collections::BTreeMap;
use std::fmt;

use ifc_lite_core::hash::{fnv1a64_extend, FNV64_OFFSET};
use ifc_lite_geometry::TessellationQuality;
use ifc_lite_processing::{process, ProcessingRequest};

fn digest_f32(values: &[f32]) -> u64 {
    values.iter().fold(FNV64_OFFSET, |h, v| fnv1a64_extend(h, &v.to_bits().to_le_bytes()))
}

fn digest_f64(values: &[f64]) -> u64 {
    values.iter().fold(FNV64_OFFSET, |h, v| fnv1a64_extend(h, &v.to_bits().to_le_bytes()))
}

fn digest_u32(values: &[u32]) -> u64 {
    values.iter().fold(FNV64_OFFSET, |h, v| fnv1a64_extend(h, &v.to_le_bytes()))
}

/// Per-mesh digests, split so the report says WHICH buffer moved. `verts` and
/// `tris` are not derivable from the digests and are what distinguishes a mesh
/// that changed shape from one that only moved.
#[derive(PartialEq, Eq, Clone, Copy, Debug)]
struct Digest {
    class: u8,
    verts: usize,
    tris: usize,
    positions: u64,
    normals: u64,
    indices: u64,
    origin: u64,
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "class={} v={} t={} pos={:016x} nrm={:016x} idx={:016x} org={:016x}",
            self.class, self.verts, self.tris, self.positions, self.normals, self.indices,
            self.origin
        )
    }
}

fn digest_run(bytes: &[u8]) -> Vec<(u32, Digest)> {
    let result = process(
        bytes,
        &ProcessingRequest::full_pass().quality(TessellationQuality::Medium),
        &mut (),
    );
    result
        .meshes
        .iter()
        .map(|m| {
            (
                m.express_id,
                Digest {
                    class: m.geometry_class,
                    verts: m.positions.len() / 3,
                    tris: m.indices.len() / 3,
                    positions: digest_f32(&m.positions),
                    normals: digest_f32(&m.normals),
                    indices: digest_u32(&m.indices),
                    origin: digest_f64(&m.origin),
                },
            )
        })
        .collect()
}

fn main() {
    let path = std::env::var("IFC_LITE_DET_FILE").expect("set IFC_LITE_DET_FILE");
    let runs: usize = std::env::var("IFC_LITE_DET_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);
    if runs < 2 {
        eprintln!("IFC_LITE_DET_RUNS must be at least 2: one import compares with nothing");
        std::process::exit(2);
    }
    let bytes = std::fs::read(&path).expect("read IFC_LITE_DET_FILE");

    let baseline = digest_run(&bytes);
    println!("baseline: {} meshes", baseline.len());
    if std::env::var("IFC_LITE_DET_PRINT").is_ok() {
        for (id, d) in &baseline {
            println!("mesh #{id} {d}");
        }
    }

    // express id -> the distinct digests seen, each with the run that first saw
    // it. The run-0 entry is the baseline, so the report shows what moved FROM.
    let mut unstable: BTreeMap<u32, Vec<(usize, Digest)>> = BTreeMap::new();
    // A run whose emit order or mesh count moved. The digest walk below pairs
    // the two runs positionally and can only speak about ids that line up, so
    // these runs are reported in their own right: the comparison itself was
    // incomplete, which is a determinism failure of its own and must not come
    // out as "stable".
    let mut misaligned = Vec::new();

    for run in 1..runs {
        let current = digest_run(&bytes);
        if current.len() != baseline.len() {
            println!("run {run}: mesh COUNT differs: {} vs {}", current.len(), baseline.len());
            misaligned.push(run);
        } else if baseline.iter().map(|(id, _)| id).ne(current.iter().map(|(id, _)| id)) {
            println!("run {run}: EMIT ORDER differs");
            misaligned.push(run);
        }
        for ((bid, bd), (cid, cd)) in baseline.iter().zip(current.iter()) {
            if bid != cid || bd == cd {
                continue;
            }
            let variants = unstable.entry(*bid).or_insert_with(|| vec![(0, *bd)]);
            if !variants.iter().any(|(_, d)| d == cd) {
                variants.push((run, *cd));
            }
        }
    }

    if !unstable.is_empty() {
        println!("UNSTABLE: {} express id(s) across {runs} runs", unstable.len());
        for (id, variants) in &unstable {
            println!("  #{id}: {} variants", variants.len());
            for (run, d) in variants {
                println!("    run {run}: {d}");
            }
        }
    }
    if !misaligned.is_empty() {
        println!("MISALIGNED: {} run(s) could not be compared mesh for mesh: {misaligned:?}", misaligned.len());
    }
    if unstable.is_empty() && misaligned.is_empty() {
        println!("STABLE across {runs} runs");
    } else {
        std::process::exit(1);
    }
}
