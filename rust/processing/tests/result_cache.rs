// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native result cache, end to end (phase 1 acceptance).
//!
//! Cold and warm runs happen in FRESH PROCESSES: this test binary re-runs
//! itself with `RC_TEST_CHILD` set, and the child prints the complete result
//! fingerprint (`ifc_lite_processing::result_fingerprint`, every field
//! including the in-memory ones; written independently of the cache codec).
//! A warm replay must equal its producer bit for bit, timings included.
//!
//! The heavy fixtures (FZK, advanced_model, schependomlaan, ISSUE_129) are in
//! the `#[ignore]`d test at the bottom: `cargo test --release -p
//! ifc-lite-processing --test result_cache -- --ignored`.

#![cfg(all(feature = "native-result-cache", not(target_arch = "wasm32")))]

#[path = "result_cache_support/mod.rs"]
mod support;

use ifc_lite_processing::result_cache::{
    BypassReason, CacheMode, CacheOutcome, MissReason, PublishOutcome, ResultCache, ResultCacheConfig,
};
use ifc_lite_processing::{process, result_fingerprint, OpeningFilterMode, ProcessingRequest};
use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use support::{cold_then_warm, fixture, in_repo_corpus, request_variant, run_child, temp_dir, Child, VARIANTS};

/// The child half of every cross-process test; a no-op in a normal run.
#[test]
fn child_process_entry() {
    support::child_main();
}

#[test]
fn warm_replay_in_a_fresh_process_equals_cold_for_the_in_repo_corpus() {
    let corpus = in_repo_corpus();
    assert!(corpus.len() >= 15, "in-repo corpus went missing: {corpus:?}");
    for (path, variant) in corpus {
        let (cold, warm) = cold_then_warm(&path, variant);
        // Determinism sanity, outside the cache: a third, uncached run agrees.
        let content = std::fs::read(&path).unwrap();
        let live = process(&content, &request_variant(variant), &mut ());
        assert_eq!(result_fingerprint(&live, false), warm.fingerprint, "{} [{variant}]: pipeline output differs between runs", path.display());
        assert_eq!(cold.fingerprint_with_timings, warm.fingerprint_with_timings);
    }
}

fn cache(dir: &std::path::Path, mode: CacheMode) -> ResultCache {
    ResultCache::new(ResultCacheConfig::default().mode(mode).directory(dir))
}

#[test]
fn off_and_bypassed_requests_do_no_cache_work_and_match_the_pipeline() {
    let content = fixture("issue_2019_wall_two_overlapping_openings.ifc");
    let dir = temp_dir("off");
    let baseline = result_fingerprint(&process(&content, &ProcessingRequest::full_pass(), &mut ()), false);

    let off = cache(&dir, CacheMode::Off).process(&content, &ProcessingRequest::full_pass());
    assert_eq!(off.report.outcome, CacheOutcome::Off);
    assert_eq!(off.report.work.bytes_hashed, 0, "off must not hash");
    assert_eq!(result_fingerprint(&off.result, false), baseline);
    assert!(!off.result.stats.from_cache);

    let read_only = cache(&dir, CacheMode::ReadOnly).process(&content, &ProcessingRequest::full_pass());
    assert_eq!(read_only.report.outcome, CacheOutcome::Miss(MissReason::Absent));
    assert_eq!(read_only.report.publish, PublishOutcome::NotAttempted);
    assert_eq!(result_fingerprint(&read_only.result, false), baseline);
    assert!(!dir.exists(), "read-only and off never create the directory");

    let rw = cache(&dir, CacheMode::ReadWrite);
    let cancellable = ProcessingRequest::full_pass().cancel(Arc::new(AtomicBool::new(false)));
    let indexed = ProcessingRequest::full_pass().index(Arc::new(ifc_lite_core::build_entity_index(&content)));
    let unretained = ProcessingRequest::full_pass().retain_meshes(false);
    for (request, reason) in [
        (cancellable, BypassReason::CancellationArmed),
        (indexed, BypassReason::InjectedEntityIndex),
        (unretained, BypassReason::MeshesNotRetained),
    ] {
        let out = rw.process(&content, &request);
        assert_eq!(out.report.outcome, CacheOutcome::Bypass(reason));
        assert_eq!(out.report.work.bytes_hashed, 0);
        assert_eq!(out.report.publish, PublishOutcome::NotAttempted);
    }
    assert!(!dir.exists(), "a bypass stores nothing");
}

#[test]
fn every_output_affecting_input_misses() {
    let content = fixture("issue_2019_wall_two_overlapping_openings.ifc");
    let dir = temp_dir("invalidation");
    let rw = cache(&dir, CacheMode::ReadWrite);
    let first = rw.process(&content, &ProcessingRequest::full_pass());
    assert!(matches!(first.report.publish, PublishOutcome::Published { .. }), "{:?}", first.report);
    let hit = rw.process(&content, &ProcessingRequest::full_pass());
    assert_eq!(hit.report.outcome, CacheOutcome::Hit);
    assert!(hit.result.stats.from_cache);

    let ro = cache(&dir, CacheMode::ReadOnly);
    for variant in VARIANTS.iter().filter(|v| **v != "full") {
        let out = ro.process(&content, &request_variant(variant));
        assert_eq!(out.report.outcome, CacheOutcome::Miss(MissReason::Absent), "variant {variant} hit the full-pass entry");
    }
    let salted = ResultCache::new(ResultCacheConfig::default().mode(CacheMode::ReadOnly).directory(&dir).engine_salt(b"next-build"));
    assert_eq!(salted.process(&content, &ProcessingRequest::full_pass()).report.outcome, CacheOutcome::Miss(MissReason::Absent));

    // One digit in the middle of the file: a sampled fingerprint can skip it.
    let mut edited = content.clone();
    let at = (edited.len() / 2..edited.len()).find(|&i| edited[i].is_ascii_digit()).unwrap();
    edited[at] = if edited[at] == b'7' { b'8' } else { b'7' };
    assert_eq!(content.iter().zip(&edited).filter(|(a, b)| a != b).count(), 1);
    assert_eq!(ro.process(&edited, &ProcessingRequest::full_pass()).report.outcome, CacheOutcome::Miss(MissReason::Absent));
    let mut longer = content.clone();
    longer.push(b'\n');
    assert_eq!(ro.process(&longer, &ProcessingRequest::full_pass()).report.outcome, CacheOutcome::Miss(MissReason::Absent));

    // None and Some(empty) are different requests, each with its own entry.
    let empty = ProcessingRequest::full_pass().ids(Some(Arc::new(HashSet::new())));
    let probe = ro.process(&content, &empty);
    assert_eq!(probe.report.outcome, CacheOutcome::Miss(MissReason::Absent));
    // An entry copied under another key (a valid file with the wrong digests).
    let entries = dir.join("result-v1");
    let entry = |key: &Option<String>| entries.join(format!("{}.ifcr", key.as_deref().unwrap()));
    std::fs::copy(entry(&hit.report.key), entry(&probe.report.key)).unwrap();
    assert_eq!(ro.process(&content, &empty).report.outcome, CacheOutcome::Miss(MissReason::IdentityMismatch));
    assert!(matches!(rw.process(&content, &empty).report.publish, PublishOutcome::Published { .. }));
    let replay = ro.process(&content, &empty);
    assert_eq!(replay.report.outcome, CacheOutcome::Hit);
    assert!(replay.result.meshes.is_empty());
    assert!(!ro.process(&content, &ProcessingRequest::full_pass()).result.meshes.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_output_affecting_environment_knob_misses_in_a_fresh_process() {
    let path = support::fixture_path("issue_2019_wall_two_overlapping_openings.ifc");
    let dir = temp_dir("env");
    let cold = run_child(&path, &dir, "rw", "full", "", &[]);
    assert_eq!(cold.outcome, "miss");
    assert_eq!(run_child(&path, &dir, "ro", "full", "", &[]).outcome, "hit");
    let knob = run_child(&path, &dir, "ro", "full", "", &[("IFC_LITE_RECT_FAST", "0")]);
    assert_eq!(knob.outcome, "miss", "IFC_LITE_RECT_FAST changes geometry and must change the key");
    let location = run_child(&path, &dir, "ro", "full", "", &[("IFC_LITE_REQUIRE_FIXTURES", "1")]);
    assert_eq!(location.outcome, "hit", "a harness-only variable must not change the key");
    let _ = std::fs::remove_dir_all(&dir);
}

/// PR #9614 review finding 1: a process-global output policy changed through
/// a public setter (not the environment) must miss, and the miss's live output
/// must be what that policy really produces. At b2ad1daf the key hashed only
/// environment strings, so every one of these hit the default-policy entry.
#[test]
fn effective_policy_overrides_are_keyed() {
    let path = support::fixture_path("issue_8190_slab_12381.ifc");
    let dir = temp_dir("policy");
    let default = support::run_policy_child(&path, &dir, "rw", "", &[]);
    assert_eq!(default.outcome, "miss");
    assert_eq!(support::run_policy_child(&path, &dir, "ro", "", &[]).outcome, "hit");
    for policy in ["local-frame-on", "csg-cap-1", "csg-cap-none", "element-cap-1", "rect-param-off", "dedup-extra-on"] {
        let changed = support::run_policy_child(&path, &dir, "ro", policy, &[]);
        assert_eq!(changed.outcome, "miss", "{policy} hit the default-policy entry");
        let live = support::run_policy_child(&path, &dir, "off", policy, &[]);
        assert_eq!(changed.fingerprint, live.fingerprint, "{policy}: the miss is the live result");
    }
    // The policy is observable, so a wrong hit would have been wrong output.
    let local_frame = support::run_policy_child(&path, &dir, "off", "local-frame-on", &[]);
    assert_ne!(local_frame.fingerprint, default.fingerprint, "local frame changes this fixture's meshes");
    // Positive control: the changed policy hits its own entry.
    assert_eq!(support::run_policy_child(&path, &dir, "rw", "local-frame-on", &[]).outcome, "miss");
    let replay = support::run_policy_child(&path, &dir, "ro", "local-frame-on", &[]);
    assert_eq!((replay.outcome.as_str(), replay.fingerprint.as_str()), ("hit", local_frame.fingerprint.as_str()));
    let _ = std::fs::remove_dir_all(&dir);
}

/// PR #9614 review finding 1, poisoning half: a writer whose cached
/// local-frame policy was read before `IFC_LITE_LOCAL_FRAME=1` was set meshes
/// with the OLD policy. A fresh process started with the variable meshes with
/// the new one and must not replay the writer's entry.
#[test]
fn a_late_environment_change_cannot_poison_a_fresh_process() {
    let path = support::fixture_path("issue_8190_slab_12381.ifc");
    let dir = temp_dir("poison");
    let writer = support::run_policy_child(&path, &dir, "rw", "late-env-local-frame", &[]);
    assert_eq!(writer.outcome, "miss");
    assert!(writer.publish.starts_with("Published"), "{}", writer.line);
    let env = [("IFC_LITE_LOCAL_FRAME", "1")];
    let fresh = support::run_policy_child(&path, &dir, "ro", "", &env);
    assert_eq!(fresh.outcome, "miss", "a fresh local-frame process replayed a non-local-frame entry");
    let live = support::run_policy_child(&path, &dir, "off", "", &env);
    assert_eq!(fresh.fingerprint, live.fingerprint);
    assert_ne!(fresh.fingerprint, writer.fingerprint, "the two policies really differ here");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn two_processes_writing_one_key_leave_one_valid_entry() {
    let path = support::fixture_path("issue_8190_slab_12381.ifc");
    let dir = temp_dir("two-writers");
    let writers: Vec<std::process::Child> =
        (0..2).map(|_| support::spawn_child(&path, &dir, "rw", "full", "", &[])).collect();
    let outs: Vec<Child> = writers.into_iter().map(support::wait_child).collect();
    for out in &outs {
        assert_eq!(out.outcome, "miss");
        assert!(["Published", "AlreadyPresent", "SkippedConcurrentWriter"].iter().any(|p| out.publish.starts_with(p)), "{}", out.publish);
    }
    let warm = run_child(&path, &dir, "ro", "full", "", &[]);
    assert_eq!(warm.outcome, "hit");
    assert!(outs.iter().any(|o| o.fingerprint_with_timings == warm.fingerprint_with_timings));
    assert!(outs.iter().all(|o| o.fingerprint == warm.fingerprint));
    let leftovers = std::fs::read_dir(dir.join("result-v1")).unwrap().flatten();
    assert_eq!(leftovers.filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn damaged_entries_on_disk_miss_warn_and_are_repaired() {
    let content = fixture("issue_6601_multicolor_element.ifc");
    let dir = temp_dir("damage");
    let rw = cache(&dir, CacheMode::ReadWrite);
    let cold = rw.process(&content, &ProcessingRequest::full_pass());
    let entry = dir.join("result-v1").join(format!("{}.ifcr", cold.report.key.clone().unwrap()));
    let good = std::fs::read(&entry).unwrap();
    let damages: [(&str, Vec<u8>); 3] = [
        ("flipped", {
            let mut b = good.clone();
            let at = b.len() - 3;
            b[at] ^= 0x40;
            b
        }),
        ("truncated", good[..good.len() / 2].to_vec()),
        ("foreign", b"IFCLNRC\x01 this is not an entry".to_vec()),
    ];
    for (name, bytes) in damages {
        std::fs::write(&entry, &bytes).unwrap();
        let out = rw.process(&content, &ProcessingRequest::full_pass());
        // A foreign header's version field is junk, so it reads as unsupported.
        let rejected = matches!(out.report.outcome, CacheOutcome::Miss(MissReason::Corrupt(_) | MissReason::Unsupported(_)));
        assert!(rejected, "{name}: {:?}", out.report.outcome);
        assert!(!out.report.warnings.is_empty(), "{name}: a rejected entry warns");
        assert_eq!(result_fingerprint(&out.result, false), result_fingerprint(&cold.result, false));
        assert!(matches!(out.report.publish, PublishOutcome::Published { .. }), "{name}: repaired");
        assert_eq!(rw.process(&content, &ProcessingRequest::full_pass()).report.outcome, CacheOutcome::Hit);
    }
    let tiny = ResultCache::new(ResultCacheConfig::default().mode(CacheMode::ReadOnly).directory(&dir).max_entry_bytes(64));
    assert!(matches!(tiny.process(&content, &ProcessingRequest::full_pass()).report.outcome, CacheOutcome::Miss(MissReason::Oversized { .. })));
    let opening = ProcessingRequest::full_pass().opening_filter(OpeningFilterMode::IgnoreAll);
    assert_eq!(cache(&dir, CacheMode::ReadOnly).process(&content, &opening).report.outcome, CacheOutcome::Miss(MissReason::Absent));
    let _ = std::fs::remove_dir_all(&dir);
}

/// PR #9614 review 2: a result whose raw payload alone is over the entry
/// limit is refused before it is encoded. At 12298a6e the whole result was
/// serialised, twice over, before the size check.
#[test]
fn a_certainly_oversized_result_is_refused_before_encoding() {
    let content = fixture("issue_8190_slab_12381.ifc");
    let dir = temp_dir("preflight");
    let tiny = ResultCache::new(ResultCacheConfig::default().mode(CacheMode::ReadWrite).directory(&dir).max_entry_bytes(64));
    let out = tiny.process(&content, &ProcessingRequest::full_pass());
    assert!(matches!(out.report.publish, PublishOutcome::SkippedOversized { limit: 64, .. }), "{:?}", out.report.publish);
    assert_eq!(out.report.work.encode, std::time::Duration::ZERO, "nothing was encoded");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The hillclimb gate's heavy fixtures, cold then warm in fresh processes.
/// Run in release: they take minutes in a debug build.
#[test]
#[ignore = "heavy fixtures; run with --release -- --ignored"]
fn warm_replay_in_a_fresh_process_equals_cold_for_heavy_fixtures() {
    let fixtures = [
        "ara3d/AC20-FZK-Haus.ifc",
        "ara3d/advanced_model.ifc",
        "ara3d/schependomlaan.ifc",
        "ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc",
    ];
    for rel in fixtures {
        let path = ifc_lite_testkit::fixture_path(rel);
        if !path.exists() {
            assert!(!ifc_lite_testkit::require_fixtures(), "missing {rel}; run `pnpm fixtures`");
            eprintln!("skipping {rel}: fixture missing; run `pnpm fixtures`");
            continue;
        }
        for variant in ["full", "instancing"] {
            let (cold, warm) = cold_then_warm(&path, variant);
            eprintln!("{rel} [{variant}]: {} | warm {}", cold.line, warm.line);
        }
    }
}
