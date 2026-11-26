// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Out-of-core source: a decoder's `content` that holds only the
//! records a worker has needed so far, instead of the whole file.
//!
//! The arena is itself a valid STEP file: the original HEADER, then a subset
//! of the DATA records in the order they were installed. Every reader that
//! takes `content: &[u8]` therefore works on it unchanged, and a reader that
//! scans by type sees the subset that was installed. The host fetches records
//! by byte range (a `File` slice, an OPFS handle, a shared buffer) and installs
//! them here; [`SparseSource::expand`] names the records a set of roots still
//! needs by walking `#id` references through what is already present.
//!
//! A lookup of an id that is not installed is recorded
//! ([`SparseIndex::take_misses`]), so a reference the forward walk cannot see
//! (an inverse relation the caller did not declare) is detected rather than
//! silently read as "entity not found".

use crate::decoder::EntityIndex;
use crate::parser::EntityScanner;
use rustc_hash::{FxHashMap, FxHashSet};
use std::sync::{Arc, Mutex, PoisonError};

/// Id to arena span, with a record of every id asked for and not found.
#[derive(Default)]
pub struct SparseIndex {
    /// Shared with the decoder, which reads it as an ordinary hash index.
    map: Arc<EntityIndex>,
    misses: Mutex<FxHashSet<u32>>,
}

impl SparseIndex {
    /// Resolve `id` to its arena span; an absent id is recorded as a miss.
    #[inline]
    pub fn lookup(&self, id: u32) -> Option<(usize, usize)> {
        let hit = self.map.get(&id).copied();
        if hit.is_none() {
            self.record_miss(id);
        }
        hit
    }

    /// Record an id a decoder looked up and did not find (the host fetches it and runs the batch again).
    #[cold]
    #[inline(never)]
    pub fn record_miss(&self, id: u32) {
        self.misses.lock().unwrap_or_else(PoisonError::into_inner).insert(id);
    }

    /// Resolve without recording a miss (the reference walk's own probe).
    #[inline]
    pub fn peek(&self, id: u32) -> Option<(usize, usize)> {
        self.map.get(&id).copied()
    }

    /// Drain the ids looked up and not found since the last drain.
    pub fn take_misses(&self) -> Vec<u32> {
        let mut misses = self.misses.lock().unwrap_or_else(PoisonError::into_inner);
        let mut ids: Vec<u32> = misses.drain().collect();
        ids.sort_unstable();
        ids
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// Call `visit` with every `#id` reference in one STEP record's attribute
/// list. Quoted strings and `/* */` comments are skipped; the record's own
/// `#id=` is not reported.
/// A reference wider than `u32` is ignored, as the decoder refuses it anyway.
pub fn for_each_record_ref(record: &[u8], mut visit: impl FnMut(u32)) {
    // Skip the instance name: everything up to and including the first `=` outside a comment.
    let len = record.len();
    let mut i = 0;
    loop {
        let Some(rel) = memchr::memchr2(b'=', b'/', &record[i..]) else { return };
        i += rel + 1;
        if record[i - 1] == b'=' {
            break;
        }
        if record.get(i) == Some(&b'*') {
            match memchr::memmem::find(&record[i + 1..], b"*/") {
                Some(close) => i += close + 3,
                None => return,
            }
        }
    }
    while i < len {
        let Some(rel) = memchr::memchr3(b'#', b'\'', b'/', &record[i..]) else { return };
        i += rel;
        if record[i] == b'/' {
            // A comment may hold a quote or a `#`: neither means anything inside it.
            if record.get(i + 1) != Some(&b'*') {
                i += 1;
                continue;
            }
            match memchr::memmem::find(&record[i + 2..], b"*/") {
                Some(close) => i += close + 4,
                None => return,
            }
            continue;
        }
        if record[i] == b'\'' {
            // A doubled quote inside a string closes and reopens it, which
            // skips the same bytes as treating it as an escape.
            match memchr::memchr(b'\'', &record[i + 1..]) {
                Some(close) => i += close + 2,
                None => return,
            }
            continue;
        }
        i += 1;
        let digits_start = i;
        let mut value: u64 = 0;
        while i < len && record[i].is_ascii_digit() {
            value = value.saturating_mul(10).saturating_add(u64::from(record[i] - b'0'));
            i += 1;
        }
        if i > digits_start {
            if let Ok(id) = u32::try_from(value) {
                visit(id);
            }
        }
    }
}

/// Counters for the host's budget decision and for the report.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SparseStats {
    pub arena_bytes: usize,
    pub base_bytes: usize,
    pub records: usize,
    pub installed_bytes_total: u64,
    pub installed_records_total: u64,
    pub resets: u32,
    /// Bumped whenever a declared inverse referrer is installed (or dropped by
    /// a reset): an index built by scanning the arena for those records is
    /// stale once this moves.
    pub referrer_generation: u32,
}

/// The sparse arena, its index and the reference-walk state.
pub struct SparseSource {
    bytes: Arc<Vec<u8>>,
    index: Arc<SparseIndex>,
    /// Length and record ids of the preamble, restored by [`Self::reset`].
    base_len: usize,
    base: EntityIndex,
    /// Ids whose references have been walked, or that the file does not hold.
    walked: FxHashSet<u32>,
    /// Records that reference a target the forward walk starts from, and must
    /// travel with it: target id to referrer ids, in file order.
    inverse: FxHashMap<u32, Vec<u32>>,
    referrers: FxHashSet<u32>,
    stats: SparseStats,
}

impl SparseSource {
    /// Start from a preamble: the file's HEADER followed by the records every
    /// worker needs (see `build_sparse_preamble`).
    pub fn new(preamble: Vec<u8>) -> Self {
        Self::with_reserve(preamble, 0)
    }

    /// [`Self::new`], reserving `reserve_bytes` of arena up front.
    ///
    /// Without a reservation the arena grows by doubling, and each growth
    /// holds the old and the new block at once: measured on a single worker,
    /// the wasm heap high-water was 2 to 5 times the arena. Reserved once, the
    /// arena never moves until it outgrows the reservation, and a reset keeps
    /// the block. Pages that are never written cost address space only.
    pub fn with_reserve(mut preamble: Vec<u8>, reserve_bytes: usize) -> Self {
        preamble.reserve_exact(reserve_bytes.saturating_sub(preamble.len()));
        let mut base = EntityIndex::default();
        let mut scanner = EntityScanner::new(&preamble);
        while let Some((id, _kw, start, end)) = scanner.next_entity() {
            base.insert(id, (start, end));
        }
        let stats = SparseStats {
            arena_bytes: preamble.len(),
            base_bytes: preamble.len(),
            records: base.len(),
            ..Default::default()
        };
        Self {
            base_len: preamble.len(),
            index: Arc::new(SparseIndex { map: Arc::new(base.clone()), misses: Mutex::default() }),
            base,
            bytes: Arc::new(preamble),
            walked: FxHashSet::default(),
            inverse: FxHashMap::default(),
            referrers: FxHashSet::default(),
            stats,
        }
    }

    /// Declare inverse edges: `referrers[i]` references `targets[i]` and must
    /// be installed whenever the target is walked. Order is preserved per
    /// target, so file-order precedence among referrers survives.
    pub fn set_inverse_edges(&mut self, targets: &[u32], referrers: &[u32]) {
        self.inverse.clear();
        self.referrers.clear();
        for (&target, &referrer) in targets.iter().zip(referrers) {
            self.inverse.entry(target).or_default().push(referrer);
            self.referrers.insert(referrer);
        }
    }

    pub fn bytes(&self) -> Arc<Vec<u8>> {
        Arc::clone(&self.bytes)
    }

    pub fn index(&self) -> Arc<SparseIndex> {
        Arc::clone(&self.index)
    }

    pub fn stats(&self) -> SparseStats {
        self.stats
    }

    pub fn contains(&self, id: u32) -> bool {
        self.index.peek(id).is_some()
    }

    /// Walk references from `ids` through the installed records and append
    /// every id that is needed and not installed to `missing` (deduplicated,
    /// ascending). After installing them, walk again from those ids.
    ///
    /// A full walk (`max_depth == u32::MAX`) expands each record once per
    /// arena lifetime, so later calls only pay for what was installed since.
    /// A depth-limited walk follows at most `max_depth` reference hops and
    /// keeps no state, so it never hides a record from a later full walk.
    pub fn expand(&mut self, ids: &[u32], max_depth: u32, missing: &mut Vec<u32>) {
        let full = max_depth == u32::MAX;
        let mut seen: FxHashSet<u32> = FxHashSet::default();
        let mut absent: FxHashSet<u32> = FxHashSet::default();
        let mut frontier: Vec<u32> = ids.to_vec();
        let mut next: Vec<u32> = Vec::new();
        let mut depth = 0u32;
        while !frontier.is_empty() {
            for &id in &frontier {
                if self.walked.contains(&id) || (!full && !seen.insert(id)) {
                    continue;
                }
                let Some((start, end)) = self.index.peek(id) else {
                    absent.insert(id);
                    continue;
                };
                if depth >= max_depth {
                    continue;
                }
                if full {
                    self.walked.insert(id);
                }
                for_each_record_ref(&self.bytes[start..end], |reference| next.push(reference));
                if let Some(referrers) = self.inverse.get(&id) {
                    next.extend_from_slice(referrers);
                }
            }
            frontier.clear();
            std::mem::swap(&mut frontier, &mut next);
            depth = depth.saturating_add(1);
        }
        let from = missing.len();
        missing.extend(absent);
        missing[from..].sort_unstable();
    }

    /// Append records. `spans` holds `(id, offset, length)` into `chunk`; each
    /// record is copied with a trailing newline. An id already installed is
    /// skipped (the first copy stays authoritative).
    pub fn install(&mut self, spans: &[(u32, usize, usize)], chunk: &[u8]) {
        let bytes = Arc::make_mut(&mut self.bytes);
        let index = match Arc::get_mut(&mut self.index) {
            Some(index) => index,
            None => {
                // A decoder from an earlier batch still holds the index: copy it.
                let copy = SparseIndex { map: Arc::clone(&self.index.map), misses: Mutex::default() };
                self.index = Arc::new(copy);
                Arc::get_mut(&mut self.index).expect("freshly created index is unshared")
            }
        };
        // Copied only if a decoder from an earlier batch still reads it.
        let map = Arc::make_mut(&mut index.map);
        for &(id, offset, length) in spans {
            let Some(record) = chunk.get(offset..offset.saturating_add(length)) else { continue };
            if record.is_empty() || map.contains_key(&id) {
                continue;
            }
            let start = bytes.len();
            bytes.extend_from_slice(record);
            bytes.push(b'\n');
            map.insert(id, (start, start + record.len()));
            if self.referrers.contains(&id) {
                self.stats.referrer_generation = self.stats.referrer_generation.wrapping_add(1);
            }
            self.stats.installed_bytes_total += record.len() as u64;
            self.stats.installed_records_total += 1;
        }
        self.stats.arena_bytes = bytes.len();
        self.stats.records = map.len();
    }

    /// Ids the file does not hold (dangling references): never reported again.
    pub fn mark_absent(&mut self, ids: &[u32]) {
        self.walked.extend(ids.iter().copied());
    }

    /// Lookups that missed since the last call, without the ids already known
    /// to be absent from the file.
    pub fn take_misses(&self) -> Vec<u32> {
        let mut misses = self.index.take_misses();
        misses.retain(|id| !self.walked.contains(id) && self.index.peek(*id).is_none());
        misses
    }

    /// Drop everything but the preamble. Spans change, so the caller must not
    /// hold a decoder or a span across this call.
    pub fn reset(&mut self) {
        // Truncate in place: the reserved block is kept for the next period.
        Arc::make_mut(&mut self.bytes).truncate(self.base_len);
        self.index = Arc::new(SparseIndex { map: Arc::new(self.base.clone()), misses: Mutex::default() });
        self.walked.clear();
        self.stats.arena_bytes = self.base_len;
        self.stats.records = self.base.len();
        self.stats.resets += 1;
        self.stats.referrer_generation = self.stats.referrer_generation.wrapping_add(1);
    }
}

/// Build the preamble every sparse worker starts from: the bytes before the
/// first DATA record (the HEADER, which declares the schema), the `closure`
/// roots with every record they reference, and the `records` roots alone, all
/// in file order. `lookup` resolves an id to its span in `content`.
pub fn build_sparse_preamble(
    content: &[u8],
    lookup: impl Fn(u32) -> Option<(usize, usize)>,
    closure_roots: &[u32],
    record_roots: &[u32],
) -> Vec<u8> {
    let header_end = EntityScanner::new(content)
        .next_entity()
        .map_or(content.len(), |(_, _, start, _)| start);
    let mut spans: FxHashMap<u32, (usize, usize)> = FxHashMap::default();
    let mut stack: Vec<u32> = closure_roots.to_vec();
    while let Some(id) = stack.pop() {
        if spans.contains_key(&id) {
            continue;
        }
        let Some((start, end)) = lookup(id) else { continue };
        let Some(record) = content.get(start..end) else { continue };
        spans.insert(id, (start, end));
        for_each_record_ref(record, |reference| stack.push(reference));
    }
    for &id in record_roots {
        if let Some((start, end)) = lookup(id).filter(|&(s, e)| content.get(s..e).is_some()) {
            spans.entry(id).or_insert((start, end));
        }
    }
    let mut ordered: Vec<(usize, usize)> = spans.into_values().collect();
    ordered.sort_unstable();
    let body: usize = ordered.iter().map(|(start, end)| end - start + 1).sum();
    let mut preamble = Vec::with_capacity(header_end + body);
    preamble.extend_from_slice(&content[..header_end]);
    for (start, end) in ordered {
        preamble.extend_from_slice(&content[start..end]);
        preamble.push(b'\n');
    }
    preamble
}

impl<'a> crate::EntityDecoder<'a> {
    /// Create a decoder over a sparse arena. `content` must be the arena that
    /// `index` spans point into.
    pub fn with_sparse_index<T>(content: &'a T, index: Arc<SparseIndex>) -> Self
    where
        T: AsRef<[u8]> + ?Sized,
    {
        // The arena's index is read as an ordinary hash index, so a decoder's lookups run the same code
        // with or without an arena. What differs is the miss path: it tells the arena's host.
        let mut decoder = Self::new(content);
        decoder.entity_index = Some(crate::columnar_index::EntityIndexStore::Hash(Arc::clone(&index.map)));
        decoder.sparse_misses = Some(index);
        decoder
    }
}

#[cfg(test)]
#[path = "sparse_source_tests.rs"]
mod tests;
