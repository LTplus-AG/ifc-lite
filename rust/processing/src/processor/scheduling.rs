// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rayon task granularity for the element loop in `process`.

use rayon::prelude::*;

/// One element per rayon task: rayon otherwise runs each thread's range of elements
/// in sequence, so a range holding a few void-heavy elements strands one core.
pub(super) fn element_tasks<T: Sync>(jobs: &[T]) -> impl IndexedParallelIterator<Item = &T> {
    jobs.par_iter().with_max_len(1)
}

#[cfg(test)]
#[path = "scheduling_tests.rs"]
mod tests;
