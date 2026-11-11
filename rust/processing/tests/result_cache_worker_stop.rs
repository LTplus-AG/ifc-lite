// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PR #9614 review 3, R3-3: a rayon worker that is already inside a stopped
//! terminal domain before the pass starts refuses every product it runs,
//! without a new `resource::stop` (the terminal branch of `check_current`
//! returns the latched error directly). The pass must not be stored: at
//! 32d3c1a3 it was, and a later clean caller replayed the degraded result.
//!
//! Its own test binary: it installs the global rayon pool.

#![cfg(all(feature = "native-result-cache", not(target_arch = "wasm32")))]

use ifc_lite_geometry::resource::{self, ProgramStop};
use ifc_lite_processing::result_cache::{CacheMode, CacheOutcome, PublishOutcome, ResultCache, ResultCacheConfig};
use ifc_lite_processing::{process, result_fingerprint, ProcessingRequest};
use std::path::PathBuf;
use std::sync::mpsc;

#[test]
fn a_worker_with_a_pre_latched_terminal_stop_never_stores_its_degraded_pass() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let bytes = std::fs::read(fixture).expect("in-repo fixture");
    let (ready_tx, ready_rx) = mpsc::channel();
    rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .spawn_handler(move |thread| {
            let ready = ready_tx.clone();
            std::thread::spawn(move || {
                let _ = resource::with_terminal_scope(|| {
                    // Latch a terminal stop on this worker, then serve the pool.
                    let _ = resource::stop(ProgramStop::Cancelled);
                    ready.send(()).unwrap();
                    thread.run();
                    Ok(())
                });
            });
            Ok(())
        })
        .build_global()
        .expect("install the global pool once");
    ready_rx.recv().unwrap();

    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("rc-r3-3-{}-{nanos}", std::process::id()));
    let cache = ResultCache::new(ResultCacheConfig::default().mode(CacheMode::ReadWrite).directory(&dir).min_free_bytes(0));
    let request = ProcessingRequest::full_pass();

    // Called from the test thread: no ambient scope here, but every product
    // runs on the stopped global worker.
    let poisoned = cache.process(&bytes, &request);
    assert!(
        !matches!(poisoned.report.publish, PublishOutcome::Published { .. }),
        "a pass whose worker ran under a stopped terminal domain was stored: {:?}",
        poisoned.report.publish
    );

    // A clean one-worker pool (same keyed worker count) must not replay it.
    let clean = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
    let live = clean.install(|| process(&bytes, &request, &mut ()));
    assert!(live.meshes.len() > poisoned.result.meshes.len(), "the stopped worker really degraded the pass");
    let replay = clean.install(|| cache.process(&bytes, &request));
    assert_ne!(replay.report.outcome, CacheOutcome::Hit, "a clean caller replayed the degraded pass");
    assert_eq!(result_fingerprint(&replay.result, false), result_fingerprint(&live, false));
    let _ = std::fs::remove_dir_all(&dir);
}
