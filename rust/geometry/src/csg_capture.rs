// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CSG corpus capture — measurement-only, behind the off-by-default
//! `csg_capture` feature (zero cost in production: the hooks compile to
//! nothing when the feature is absent).
//!
//! Every real void cut funnels through exactly one of
//! [`crate::kernel::mesh_bridge::subtract`] / `subtract_many`, so recording at
//! that boundary captures the complete, dedup-by-construction CSG work corpus
//! the pipeline actually performed on a model. The replay harness
//! (`rust/processing/examples/csg_scaling_bench.rs`) drives the native pipeline
//! once to populate this, then re-runs the captured jobs under scoped rayon
//! pools to measure whether across-element exact CSG scales with cores.
//!
//! This exists to settle "rung 1" of the in-WASM shared-memory threading
//! question (see `project_wasm_csg_speed_is_worker_throttle` memory): does the
//! pure-Rust exact kernel scale with cores at all on native, before paying for
//! a threaded wasm build to measure the wasm-specific taxes.

use crate::mesh::Mesh;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// One real CSG invocation captured from the pipeline. Holds owned copies of
/// the exact inputs the kernel received, so the replay is faithful.
#[derive(Clone)]
pub enum CapturedCsgJob {
    /// A single `host − cutter` (a single-opening element, or one step of a
    /// sequential per-cutter fallback).
    Single { host: Mesh, cutter: Mesh, opening: bool },
    /// A batched `host − (∪ cutters)` (the disjoint-opening fast group).
    Many { host: Mesh, cutters: Vec<Mesh>, opening: bool, retain_miss: bool },
}

impl CapturedCsgJob {
    /// Replay with the captured weld policy through the normal validation,
    /// consolidation and accept gates. Recording should be disabled first.
    pub fn replay(&self, csg: &crate::csg::ClippingProcessor) -> crate::csg::GroupCut {
        match self {
            Self::Single { host, cutter, opening: true } => csg.subtract_mesh(host, cutter),
            Self::Single { host, cutter, opening: false } => csg.subtract_operand(host, cutter),
            Self::Many { host, cutters, opening, retain_miss } => {
                let refs: Vec<&Mesh> = cutters.iter().collect();
                csg.replay_captured_many(host, &refs, *opening, *retain_miss)
            }
        }
    }
}

static CAPTURED: Mutex<Vec<CapturedCsgJob>> = Mutex::new(Vec::new());

/// Recording is OFF unless a capture run explicitly enables it. CRITICAL for
/// measurement validity: the kernel `subtract`/`subtract_many` hooks ALSO fire
/// when a bench replays the captured corpus — without this gate, every replayed
/// cut would lock `CAPTURED` and clone its meshes, serializing rayon threads on
/// one Mutex and distorting the very scaling numbers the bench measures. So the
/// capture run wraps the pipeline in `set_enabled(true)`; replay leaves it off.
static CAPTURE_ENABLED: AtomicBool = AtomicBool::new(false);

/// Turn recording on/off. Call `set_enabled(true)` only around the pipeline pass
/// that should populate the corpus, then `set_enabled(false)` before replaying.
pub fn set_enabled(on: bool) {
    CAPTURE_ENABLED.store(on, Ordering::Relaxed);
}

#[inline]
fn enabled() -> bool {
    CAPTURE_ENABLED.load(Ordering::Relaxed)
}

/// Record a single-pair subtract. Called from the kernel boundary. No-op (one
/// relaxed atomic load) unless a capture run is active.
pub fn record_single(host: &Mesh, cutter: &Mesh, opening: bool) {
    if !enabled() {
        return;
    }
    if let Ok(mut v) = CAPTURED.lock() {
        v.push(CapturedCsgJob::Single { host: host.clone(), cutter: cutter.clone(), opening });
    }
}

/// Record a batched subtract with its effective miss policy after chunking.
/// Called from the kernel boundary. No-op unless a capture run is active.
pub fn record_many(host: &Mesh, cutters: &[&Mesh], opening: bool, retain_miss: bool) {
    if !enabled() {
        return;
    }
    if let Ok(mut v) = CAPTURED.lock() {
        v.push(CapturedCsgJob::Many {
            host: host.clone(),
            cutters: cutters.iter().map(|m| (*m).clone()).collect(),
            opening,
            retain_miss,
        });
    }
}

/// Take everything captured so far, clearing the buffer.
pub fn drain() -> Vec<CapturedCsgJob> {
    CAPTURED.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
}

// --- Manual little-endian (de)serialization (Mesh has no serde) ---------------
// Shared by the native dumper and the wasm replay harness so the format can't
// drift. Format v3: ASCII CSG3, u32 job_count, then per job: u8 tag.
// Bits: 0=batch, 1=opening weld, 2=retain conforming miss (batch only).
// Valid tags: 0/2=Single, 1/3/5/7=Many under both captured policies,
// mesh(host), [mesh(cutter) | u32 n + n×mesh(cutter)]. mesh = u32 pos_len +
// f32×, u32 norm_len + f32×, u32 idx_len + u32×, u8 rtc_applied, f64×3 origin.

fn push_mesh(out: &mut Vec<u8>, m: &Mesh) {
    out.extend_from_slice(&(m.positions.len() as u32).to_le_bytes());
    for v in &m.positions {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&(m.normals.len() as u32).to_le_bytes());
    for v in &m.normals {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&(m.indices.len() as u32).to_le_bytes());
    for v in &m.indices {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.push(m.rtc_applied as u8);
    for v in &m.origin {
        out.extend_from_slice(&v.to_le_bytes());
    }
}

/// Serialize a captured corpus to a self-describing little-endian blob.
pub fn serialize(jobs: &[CapturedCsgJob]) -> Vec<u8> {
    let mut out = b"CSG3".to_vec();
    out.extend_from_slice(&(jobs.len() as u32).to_le_bytes());
    for j in jobs {
        match j {
            CapturedCsgJob::Single { host, cutter, opening } => {
                out.push(if *opening { 2 } else { 0 });
                push_mesh(&mut out, host);
                push_mesh(&mut out, cutter);
            }
            CapturedCsgJob::Many { host, cutters, opening, retain_miss } => {
                out.push(1 | (u8::from(*opening) << 1) | (u8::from(*retain_miss) << 2));
                push_mesh(&mut out, host);
                out.extend_from_slice(&(cutters.len() as u32).to_le_bytes());
                for c in cutters {
                    push_mesh(&mut out, c);
                }
            }
        }
    }
    out
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Reader<'a> {
    /// Bounds-checked slice advance; `None` on underflow (truncated blob).
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.p..self.p.checked_add(n)?)?;
        self.p += n;
        Some(s)
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn f32(&mut self) -> Option<f32> {
        Some(f32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn f64(&mut self) -> Option<f64> {
        Some(f64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn mesh(&mut self) -> Option<Mesh> {
        let n = self.u32()? as usize;
        let positions: Vec<f32> = (0..n).map(|_| self.f32()).collect::<Option<_>>()?;
        let n = self.u32()? as usize;
        let normals: Vec<f32> = (0..n).map(|_| self.f32()).collect::<Option<_>>()?;
        let n = self.u32()? as usize;
        let indices: Vec<u32> = (0..n).map(|_| self.u32()).collect::<Option<_>>()?;
        let rtc_applied = self.u8()? != 0;
        let origin = [self.f64()?, self.f64()?, self.f64()?];
        // `welded_in_object_frame: false`, and the blob deliberately does not
        // carry the bit. The field's only non-test reader in the tree is the
        // `debug_assert!` at rust/processing/src/element_mesh_build.rs:61
        // (`instance_meta.is_none() || welded_in_object_frame`), and a
        // deserialized job always has `instance_meta: None`, so the assert holds
        // trivially and nothing branches on the value here. It is inert on this
        // path, and `false` is the conservative reading of a blob whose format
        // (line 92) predates #4122.
        //
        // The round trip therefore DROPS the bit, with no format version that
        // would notice. If a reader ever branches on it, `push_mesh` must learn to
        // write it and the format must gain a version. Pinned by
        // `deserialize_defaults_welded_in_object_frame_to_false`.
        Some(Mesh {
            positions,
            normals,
            indices,
            rtc_applied,
            origin,
            instance_meta: None,
            local_bounds: None,
            local_to_world: None,
            welded_in_object_frame: false,
            plane_tags: None,
        })
    }
}

/// Deserialize a blob produced by [`serialize`]. Returns `Err` on a truncated or
/// malformed blob instead of panicking — the wasm bench path must not trap.
pub fn deserialize(blob: &[u8]) -> Result<Vec<CapturedCsgJob>, &'static str> {
    let mut r = Reader { b: blob, p: 0 };
    // Unversioned corpora lack weld policy; CSG2 lacks retained-miss policy.
    // Either may mix callers, so neither policy can safely be guessed.
    if r.take(4) != Some(&b"CSG3"[..]) {
        return Err("unsupported capture format: recapture corpus with weld and miss policies");
    }
    let n = r.u32().ok_or("truncated blob: missing job count")? as usize;
    // Don't pre-size from the untrusted count (nor from blob.len(), which over-
    // allocates ~30x since the smallest job is dozens of bytes) — just grow.
    let mut jobs = Vec::new();
    for _ in 0..n {
        let tag = r.u8().ok_or("truncated blob: missing tag")?;
        let host = r.mesh().ok_or("truncated blob: bad host mesh")?;
        match tag {
            0 | 2 => {
                let cutter = r.mesh().ok_or("truncated blob: bad cutter mesh")?;
                jobs.push(CapturedCsgJob::Single { host, cutter, opening: tag == 2 });
            }
            1 | 3 | 5 | 7 => {
                let nc = r.u32().ok_or("truncated blob: missing cutter count")? as usize;
                let cutters: Vec<Mesh> =
                    (0..nc).map(|_| r.mesh()).collect::<Option<_>>().ok_or("truncated blob: bad cutter mesh")?;
                jobs.push(CapturedCsgJob::Many { host, cutters, opening: tag & 2 != 0, retain_miss: tag & 4 != 0 });
            }
            _ => return Err("invalid job tag"),
        }
    }
    // A well-formed blob is fully consumed; leftover bytes mean corruption.
    if r.p != blob.len() {
        return Err("trailing bytes after last job");
    }
    Ok(jobs)
}

#[cfg(test)]
#[path = "csg_capture_tests.rs"]
mod tests;
