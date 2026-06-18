// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Large-stack worker pool, mirroring `ifc-lite-ffi` and the Tauri shell.
//!
//! Exact-kernel CSG and nested boolean clipping recurse deeply enough to
//! overflow the default ~1 MiB worker stack on pathological elements (a wall
//! with hundreds of openings), which aborts the process. Running the engine on
//! a pool whose workers have a 256 MiB stack gives that recursion room; wrapping
//! the call in `pool.install(..)` makes the pipeline's internal `par_iter` use
//! these workers.

use std::sync::OnceLock;

const PARSE_STACK_SIZE: usize = 256 * 1024 * 1024;

fn parse_pool() -> &'static rayon::ThreadPool {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .stack_size(PARSE_STACK_SIZE)
            .thread_name(|i| format!("ifc-lite-desktop-server-{i}"))
            .build()
            .expect("failed to build ifc-lite desktop-server thread pool")
    })
}

/// Run `f` on the large-stack pool. `f` and its result must be `Send`.
pub fn run_on_large_stack<R, F>(f: F) -> R
where
    F: FnOnce() -> R + Send,
    R: Send,
{
    parse_pool().install(f)
}
