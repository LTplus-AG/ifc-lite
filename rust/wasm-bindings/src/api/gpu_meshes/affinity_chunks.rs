// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Publish each affinity chunk before computing any key in the next chunk.

/// The caller owns its decoder and signature memo for the entire stream.
/// `chunk_size` must be positive, as enforced by the prepass entry point.
#[inline(always)]
pub(super) fn emit_affinity_chunks<T, E>(
    jobs: &[T],
    chunk_size: usize,
    mut routing_key: impl FnMut(&T) -> u32,
    mut emit: impl FnMut(&[T], &[u32]) -> Result<(), E>,
) -> Result<(), E> {
    let mut affinity: Vec<u32> = Vec::with_capacity(jobs.len().min(chunk_size));
    for jobs_chunk in jobs.chunks(chunk_size) {
        affinity.clear();
        for job in jobs_chunk {
            affinity.push(routing_key(job));
        }
        emit(jobs_chunk, &affinity)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "affinity_chunks_tests.rs"]
mod tests;
