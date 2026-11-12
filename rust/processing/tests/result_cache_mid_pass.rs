// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native result cache under changing process state (PR #9614 review 2).
//!
//! R2-1: an output-policy setter that runs while a pass meshes, and is undone
//! before the pass ends (A -> B -> A), must stop the result being stored.
//! R2-2: a pass inside an execution account, source stop or terminal domain
//! must bypass the cache both ways, and a pass during which any product was
//! stopped must not be stored.
//!
//! These mutate process-global policy and count process-global stops, so they
//! run one at a time (`SERIAL`) in their own test binary.

#![cfg(all(feature = "native-result-cache", not(target_arch = "wasm32")))]

use ifc_lite_geometry::resource::{self, Dimension, ExecutionAccount, ExecutionPolicy, RefusalReason, ResourceLimits};
use ifc_lite_processing::result_cache::{
    BypassReason, CacheMode, CacheOutcome, MissReason, PublishOutcome, ResultCache, ResultCacheConfig,
};
use ifc_lite_processing::{process, result_fingerprint, Batching, ProcessingRequest};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

static SERIAL: Mutex<()> = Mutex::new(());

fn fixture() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    std::fs::read(path).expect("in-repo fixture")
}

fn fresh_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    std::env::temp_dir().join(format!("ifc-lite-rc-midpass-{tag}-{}-{nanos}", std::process::id()))
}

/// One job per batch, so a hook runs between products.
fn per_product() -> ProcessingRequest {
    ProcessingRequest::full_pass().batching(Batching::new(1, 1))
}

fn cache(dir: &Path, mode: CacheMode) -> ResultCache {
    ResultCache::new(ResultCacheConfig::default().mode(mode).directory(dir))
}

/// R2-1. At 12298a6e the guard compared policy VALUES at the ends of the
/// pass; local frame flipped on after batch 1 and back off after batch 2 left
/// them equal, so the mixed result was published under the default key.
#[test]
fn a_policy_change_undone_mid_pass_is_never_stored() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let content = fixture();
    let dir = fresh_dir("aba");
    let pure = result_fingerprint(&process(&content, &per_product(), &mut ()), false);
    let batches = Arc::new(AtomicUsize::new(0));
    let seen = batches.clone();
    let flipping = ResultCache::new(ResultCacheConfig::default().mode(CacheMode::ReadWrite).directory(&dir).pass_hook(
        move |batch| {
            seen.store(batch, Ordering::SeqCst);
            match batch {
                1 => ifc_lite_geometry::local_frame_set_enabled_override(Some(true)),
                2 => ifc_lite_geometry::local_frame_set_enabled_override(None),
                _ => {}
            }
        },
    ));
    let out = flipping.process(&content, &per_product());
    assert!(batches.load(Ordering::SeqCst) >= 3, "fixture must give at least three batches");
    assert_eq!(out.report.outcome, CacheOutcome::Miss(MissReason::Absent));
    assert_eq!(out.report.publish, PublishOutcome::SkippedPolicyChanged, "mixed-policy result stored");
    // The hazard is real: the second product meshed in the local frame.
    assert_ne!(result_fingerprint(&out.result, false), pure, "the flip changed this pass's output");
    // Nothing is replayable, and an undisturbed pass stores normally.
    assert_eq!(cache(&dir, CacheMode::ReadOnly).process(&content, &per_product()).report.outcome, CacheOutcome::Miss(MissReason::Absent));
    let clean = cache(&dir, CacheMode::ReadWrite).process(&content, &per_product());
    assert!(matches!(clean.report.publish, PublishOutcome::Published { .. }), "{:?}", clean.report.publish);
    assert_eq!(result_fingerprint(&clean.result, false), pure);
    let _ = std::fs::remove_dir_all(&dir);
}

/// R2-2. A cancelled (or merely bounded) execution account, or a terminal
/// domain, on the calling thread changes what the pass produces; at 12298a6e
/// the cache hit through it and stored what it produced.
#[test]
fn ambient_resource_scopes_bypass_the_cache_both_ways() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let content = fixture();
    let request = ProcessingRequest::full_pass();
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
    let cancelled = || {
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        account.cancel();
        account
    };
    pool.install(|| {
        // Stopped cold run first: it must neither store nor be replayed.
        let dir = fresh_dir("stopped-first");
        let rw = cache(&dir, CacheMode::ReadWrite);
        let (live, cached) = cancelled().scope(|| (process(&content, &request, &mut ()), rw.process(&content, &request)));
        assert_eq!(cached.report.outcome, CacheOutcome::Bypass(BypassReason::AmbientResourceScope));
        assert_eq!(cached.report.publish, PublishOutcome::NotAttempted);
        assert_eq!(result_fingerprint(&cached.result, false), result_fingerprint(&live, false));
        let ordinary = rw.process(&content, &request);
        assert_eq!(ordinary.report.outcome, CacheOutcome::Miss(MissReason::Absent), "the stopped run stored nothing");
        assert!(matches!(ordinary.report.publish, PublishOutcome::Published { .. }), "{:?}", ordinary.report.publish);
        assert!(live.meshes.len() < ordinary.result.meshes.len(), "cancellation really changes the output");

        // Ordinary entry first: a cancelled scope must get the live refusal, not a hit.
        let (live, cached) = cancelled().scope(|| (process(&content, &request, &mut ()), rw.process(&content, &request)));
        assert_eq!(cached.report.outcome, CacheOutcome::Bypass(BypassReason::AmbientResourceScope));
        assert_eq!(result_fingerprint(&cached.result, false), result_fingerprint(&live, false));

        // A bounded, uncancelled account and a terminal domain bypass too.
        let bounded = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        assert_eq!(bounded.scope(|| rw.process(&content, &request)).report.outcome, CacheOutcome::Bypass(BypassReason::AmbientResourceScope));
        let terminal = resource::with_terminal_scope(|| Ok(rw.process(&content, &request))).unwrap();
        assert_eq!(terminal.report.outcome, CacheOutcome::Bypass(BypassReason::AmbientResourceScope));
        // Outside any scope the entry hits.
        assert_eq!(rw.process(&content, &request).report.outcome, CacheOutcome::Hit);
        let _ = std::fs::remove_dir_all(&dir);
    });
}

/// R2-2, worker side: a stop anywhere in the process while the pass runs (here
/// an unrelated cancelled account on another thread, as a stolen rayon job
/// would see) keeps the result out of the cache.
#[test]
fn a_stop_during_the_pass_is_never_stored() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let content = fixture();
    let dir = fresh_dir("stop");
    let stopping = ResultCache::new(ResultCacheConfig::default().mode(CacheMode::ReadWrite).directory(&dir).pass_hook(
        |batch| {
            if batch == 1 {
                std::thread::spawn(|| {
                    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
                    account.cancel();
                    account.scope(|| assert!(resource::check_current().is_err()));
                    let _ = resource::refused(Dimension::Work, 1, 0, RefusalReason::Limit);
                })
                .join()
                .unwrap();
            }
        },
    ));
    let out = stopping.process(&content, &per_product());
    assert_eq!(out.report.publish, PublishOutcome::SkippedResourceStop);
    assert_eq!(cache(&dir, CacheMode::ReadOnly).process(&content, &per_product()).report.outcome, CacheOutcome::Miss(MissReason::Absent));
    let _ = std::fs::remove_dir_all(&dir);
}

/// Inventory rows (PR #9614 review 3): two process/thread state channels that
/// reach the pipeline but are proven not to change its result, so the cache
/// neither keys them nor bypasses on them.
/// - `ifc_lite_geometry::analytic::with_source_capture` (thread-local): fills
///   analytic `source` fields for exports, not `ProcessingResult`.
/// - `ifc_lite_geometry::progress::set_hook` (process-global, set once): a
///   liveness heartbeat; a hit simply makes no ticks.
#[test]
fn source_capture_and_the_progress_hook_are_output_neutral() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    static TICKS: AtomicUsize = AtomicUsize::new(0);
    fn tick() {
        TICKS.fetch_add(1, Ordering::Relaxed);
    }
    let content = fixture();
    let request = ProcessingRequest::full_pass();
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
    let plain = pool.install(|| result_fingerprint(&process(&content, &request, &mut ()), false));
    let captured = pool.install(|| {
        ifc_lite_geometry::analytic::with_source_capture(|| result_fingerprint(&process(&content, &request, &mut ()), false))
    });
    assert_eq!(captured, plain, "source capture changed the result");
    let installed = ifc_lite_geometry::progress::set_hook(tick);
    let hooked = pool.install(|| result_fingerprint(&process(&content, &request, &mut ()), false));
    assert_eq!(hooked, plain, "the progress hook changed the result");
    if installed {
        assert!(TICKS.load(Ordering::Relaxed) > 0, "the hook really ran");
    }
    // And the cache treats neither as a reason to bypass.
    let dir = fresh_dir("neutral");
    let rw = cache(&dir, CacheMode::ReadWrite);
    let cold = pool.install(|| rw.process(&content, &request));
    assert!(matches!(cold.report.publish, PublishOutcome::Published { .. }), "{:?}", cold.report.publish);
    let hit = pool.install(|| ifc_lite_geometry::analytic::with_source_capture(|| rw.process(&content, &request)));
    assert_eq!(hit.report.outcome, CacheOutcome::Hit);
    assert_eq!(result_fingerprint(&hit.result, false), plain);
    let _ = std::fs::remove_dir_all(&dir);
}
