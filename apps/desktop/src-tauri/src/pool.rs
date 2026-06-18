// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Large-stack worker pool, mirroring `ifc-lite-ffi`.
//!
//! IFC geometry recurses deeply: exact-kernel CSG and chains of nested boolean
//! clipping (a wall with hundreds of openings) build call stacks far past the
//! default ~1 MiB worker stack. Overflowing it hits the guard page and aborts
//! the whole app — no panic, nothing recoverable. Running the engine inside a
//! pool whose workers have a 256 MiB stack gives that recursion room. The
//! pipeline's internal `par_iter` runs on these workers because we wrap the
//! whole call in `pool.install(..)`.

use std::sync::OnceLock;

/// Stack size for geometry worker threads (256 MiB), matching the FFI crate.
const PARSE_STACK_SIZE: usize = 256 * 1024 * 1024;

fn parse_pool() -> &'static rayon::ThreadPool {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .stack_size(PARSE_STACK_SIZE)
            .thread_name(|i| format!("ifc-lite-desktop-{i}"))
            .build()
            .expect("failed to build ifc-lite desktop thread pool")
    })
}

/// Run `f` on the large-stack pool so it (and every nested `par_iter`) uses the
/// large-stack workers. `f` and its result must be `Send` (they cross to a pool
/// worker and back).
pub fn run_on_large_stack<R, F>(f: F) -> R
where
    F: FnOnce() -> R + Send,
    R: Send,
{
    parse_pool().install(f)
}
