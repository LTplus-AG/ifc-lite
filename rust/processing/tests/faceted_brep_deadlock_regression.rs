// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for the native nested-`par_iter` re-entrancy self-deadlock
//! introduced by the persistent per-worker CartesianPoint cache (#1572).
//!
//! That cache is a `Vec<Mutex<FxHashMap>>` indexed by `rayon::current_thread_index()`,
//! locked and held across the whole element job. Faceted-brep triangulation nests
//! a rayon `par_iter`, so a worker blocked at that nested join can work-steal
//! another element job onto its OWN thread index and re-lock the non-reentrant
//! `std::sync::Mutex` it already holds -> self-deadlock. It fires reliably on
//! faceted-brep-heavy models under the multithreaded native pool (wasm meshes
//! single-threaded per worker and is unaffected). Fixed by `try_lock` + a
//! throwaway-cache fallback for the re-entrant job (byte-identical: the cache is
//! pure memoization of deterministic coordinates).
//!
//! This drives a faceted-brep-heavy fixture through the full multithreaded
//! pipeline several times under a watchdog. A re-introduced deadlock parks the
//! worker forever, so the timeout fails the test instead of hanging CI.

use std::sync::mpsc;
use std::time::Duration;

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/models/ara3d/schependomlaan.ifc"
);

#[test]
fn multithreaded_faceted_brep_pipeline_does_not_deadlock() {
    let Ok(content) = std::fs::read(FIXTURE) else {
        eprintln!(
            "skipping: fixture {FIXTURE} not present — run `pnpm fixtures` \
             (sha256 in tests/models/manifest.json)"
        );
        return;
    };

    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        // The deadlock reproduced on the first full-model pass, so a few
        // multithreaded passes reliably re-trip a reintroduced bug.
        for _ in 0..3 {
            let result = ifc_lite_processing::process_geometry(&content);
            // Sanity: the model does produce geometry (guards against a fixture
            // that silently stopped exercising the faceted-brep path).
            assert!(
                !result.meshes.is_empty(),
                "fixture produced no meshes — it may no longer exercise faceted breps"
            );
        }
        let _ = tx.send(());
    });

    // A clean run is a few seconds even in a debug build; 180s is a generous
    // ceiling. A deadlocked worker never sends, so recv_timeout fires and fails
    // the test rather than hanging the suite.
    match rx.recv_timeout(Duration::from_secs(180)) {
        Ok(()) => {
            let _ = worker.join();
        }
        Err(_) => panic!(
            "process_geometry deadlocked on a faceted-brep-heavy model — the \
             nested-par_iter worker-point-cache re-entrancy regression is back \
             (#1572; fix is `try_lock` in processor/mod.rs)"
        ),
    }
}
