// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! EDGE-FFI-1 (#7673): deep recursion inside a `par_iter` job must survive on
//! the geometry pool. The control proves the same job overflows a default
//! rayon worker stack, so the first test is not vacuous.

use super::*;
use rayon::prelude::*;

/// Recursion depth of [`burn_stack`]: about 16 MiB of stack at >= 1 KiB per
/// frame. That is 8x a default 2 MiB rayon worker stack and 1/16 of
/// [`GEOMETRY_STACK_BYTES`], and costs a few milliseconds.
const DEPTH: u32 = 16 * 1024;

/// Recurse `depth` levels, each holding a 1 KiB frame that stays live across
/// the recursive call (its address escapes through `black_box` after the
/// call), so the optimiser can neither shrink the frame nor turn the
/// recursion into a loop.
#[inline(never)]
fn burn_stack(depth: u32) -> u64 {
    let mut frame = [0u8; 1024];
    frame[(depth as usize) % 1024] = 1;
    let frame = std::hint::black_box(frame);
    if depth == 0 {
        return 0;
    }
    let below = burn_stack(depth - 1);
    below + u64::from(std::hint::black_box(&frame)[(depth as usize) % 1024])
}

/// The job every test runs: [`burn_stack`] on several `par_iter` items, so the
/// recursion happens on pool workers, not on the calling thread.
fn deep_par_iter_job() -> u64 {
    (0..8u32).into_par_iter().map(|_| burn_stack(DEPTH)).sum()
}

#[test]
fn deep_recursion_in_a_par_iter_job_survives_on_the_geometry_pool() {
    let (sum, worker_names) = run_on_geometry_pool(|| {
        let names: Vec<String> = (0..8u32)
            .into_par_iter()
            .map(|_| std::thread::current().name().unwrap_or_default().to_string())
            .collect();
        (deep_par_iter_job(), names)
    })
    .expect("geometry pool builds");
    assert_eq!(sum, 8 * u64::from(DEPTH));
    assert!(
        worker_names.iter().all(|n| n.starts_with("ifc-lite-geometry-")),
        "par_iter jobs started inside run_on_geometry_pool must run on its workers, got {worker_names:?}"
    );
}

/// The control, and the EDGE-FFI-1 reproduction. Runs the same job the way the
/// Python bindings used to: from a freshly spawned thread with a
/// [`GEOMETRY_STACK_BYTES`] stack, so the `par_iter` jobs land on rayon's
/// default-stack global pool. It runs in a child copy of this test binary (an
/// overflow aborts the process, which would take the test runner with it), and
/// the child must die of a stack overflow. If the optimiser ever flattens
/// [`burn_stack`], this fails and says the first test stopped proving anything.
#[test]
fn the_same_job_overflows_a_default_rayon_worker_stack() {
    const REPRO_ENV_VAR: &str = "IFC_LITE_GEOMETRY_POOL_DEFAULT_STACK_REPRO";

    if std::env::var(REPRO_ENV_VAR).is_ok() {
        let sum = std::thread::Builder::new()
            .stack_size(GEOMETRY_STACK_BYTES)
            .spawn(deep_par_iter_job)
            .expect("spawn the big-stack caller")
            .join()
            .expect("caller thread");
        eprintln!("the global pool survived the deep job (sum {sum})");
        std::process::exit(0);
    }

    let exe = std::env::current_exe().expect("current test exe");
    let output = std::process::Command::new(exe)
        .args([
            "geometry_pool::tests::the_same_job_overflows_a_default_rayon_worker_stack",
            "--exact",
            "--nocapture",
        ])
        .env(REPRO_ENV_VAR, "1")
        // A default worker stack is 2 MiB unless RUST_MIN_STACK says otherwise.
        .env_remove("RUST_MIN_STACK")
        .output()
        .expect("failed to spawn child test process");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !output.status.success() && stderr.contains("overflowed its stack"),
        "the deep job must overflow a default-stack rayon worker, or the pool test \
         above proves nothing; child exit status = {:?}\n--- child stderr ---\n{stderr}",
        output.status
    );
}

/// Building the pool used to `.expect` on the FFI's `extern "C"` path
/// (#4614). A 2^62-byte stack makes the thread spawn fail for real; the
/// result must be an `Err`, and a failure must not be cached.
#[cfg(target_pointer_width = "64")]
#[test]
fn a_pool_that_cannot_spawn_its_threads_is_an_error_not_a_panic() {
    static CELL: OnceLock<ThreadPool> = OnceLock::new();
    assert!(get_or_build(&CELL, || geometry_pool_builder().stack_size(1 << 62).build()).is_err());
    assert!(CELL.get().is_none(), "a failed build is not cached");
    let pool = get_or_build(&CELL, || geometry_pool_builder().num_threads(1).build());
    assert!(pool.is_ok(), "a later call retries the build");
}
