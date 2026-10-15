// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one home for the large-stack rayon pool that native geometry runs on
//! (EDGE-FFI-1 / EDGE-FFI-3, #7673).
//!
//! Per-element geometry runs inside `process_geometry` and the analytic
//! extractors via `par_iter`, so the deep recursion (nested boolean clipping,
//! the exact CSG kernel, long placement and mapped-item chains) lives on the
//! *rayon worker* stacks, not the caller's. A stack overflow is not a panic: it
//! hits the guard page and aborts the whole host (the Rhino process behind the
//! FFI, the Python interpreter, every request on the server), and no
//! `catch_unwind` or `join` can intercept it. Spawning one big-stack OS thread
//! and calling the pipeline from it, as the Python bindings used to, only
//! enlarges the serial part; the `par_iter` jobs still run on rayon's global
//! pool with default stacks.
//!
//! Consumers:
//! - FFI and Python run their whole call through [`run_on_geometry_pool`], so
//!   the entry closure and every nested `par_iter` run on these workers.
//! - The server builds its global pool from [`geometry_pool_builder`], so every
//!   rayon job it runs, CSG included, already has the large stack.

use std::sync::OnceLock;

use rayon::{ThreadPool, ThreadPoolBuildError, ThreadPoolBuilder};

/// Stack size for every rayon worker that runs geometry (256 MiB).
///
/// Reserved address space, not committed memory: a worker only touches the
/// pages its recursion actually reaches.
pub const GEOMETRY_STACK_BYTES: usize = 256 * 1024 * 1024;

/// A [`ThreadPoolBuilder`] whose workers have [`GEOMETRY_STACK_BYTES`] stacks.
/// Callers may add `num_threads` and then `build` or `build_global`.
pub fn geometry_pool_builder() -> ThreadPoolBuilder {
    ThreadPoolBuilder::new()
        .stack_size(GEOMETRY_STACK_BYTES)
        .thread_name(|i| format!("ifc-lite-geometry-{i}"))
}

/// The process-wide large-stack pool, built on first use.
///
/// An `Err` when the OS refuses to spawn the threads; never a panic, because
/// the FFI calls this on an `extern "C"` path where an unwind aborts the host.
/// A failed build is not cached, so a later call retries. Two first calls
/// racing may each build a pool; the loser is dropped.
pub fn geometry_pool() -> Result<&'static ThreadPool, ThreadPoolBuildError> {
    static POOL: OnceLock<ThreadPool> = OnceLock::new();
    get_or_build(&POOL, || geometry_pool_builder().build())
}

fn get_or_build<E>(
    cell: &'static OnceLock<ThreadPool>,
    build: impl FnOnce() -> Result<ThreadPool, E>,
) -> Result<&'static ThreadPool, E> {
    if let Some(pool) = cell.get() {
        return Ok(pool);
    }
    let pool = build()?;
    Ok(cell.get_or_init(|| pool))
}

/// Run `work` on [`geometry_pool`], so it and every rayon job it starts run on
/// large-stack workers. Blocks the calling thread until `work` returns.
///
/// A panic in `work` is resumed on the calling thread (rayon's `install`), so
/// a caller that must not unwind wraps this in `catch_unwind`.
pub fn run_on_geometry_pool<T: Send>(
    work: impl FnOnce() -> T + Send,
) -> Result<T, ThreadPoolBuildError> {
    Ok(geometry_pool()?.install(work))
}

#[cfg(test)]
#[path = "geometry_pool_tests.rs"]
mod tests;
