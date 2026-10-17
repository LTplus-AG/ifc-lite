// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C4-0: a whole-result digest and an event trace for the processing entry
//! points, so a refactor of the pipeline's front door can be held to
//! "byte-identical output, same event order" on a fixture set.
//!
//! The digest covers everything a consumer reads off a [`ProcessingResult`]
//! (every mesh field, instances, frame, transforms, metadata, counters) except
//! the wall-clock timers, which differ between two runs of the same code.

use ifc_lite_processing::{ProcessingResult, QuickMetadataBootstrap};
use std::hash::Hasher;

/// FNV-1a 64, so a digest is stable across Rust versions and platforms.
#[derive(Default)]
pub struct Fnv(u64);

impl Fnv {
    pub fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
}

impl Hasher for Fnv {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
}

pub fn fnv(text: &str) -> u64 {
    let mut h = Fnv::new();
    h.write(text.as_bytes());
    h.finish()
}

/// Everything in `result` except the timers, as one comparable string.
pub fn result_digest(result: &ProcessingResult) -> String {
    let mut stats = result.stats.clone();
    stats.parse_time_ms = 0;
    stats.entity_scan_time_ms = 0;
    stats.lookup_time_ms = 0;
    stats.preprocess_time_ms = 0;
    stats.geometry_time_ms = 0;
    stats.total_time_ms = 0;
    stats.faceted_brep_time_ms = 0;
    // Per-worker point caches: hits and misses depend on which worker met which
    // element first, so they differ between two runs of the same code.
    stats.point_cache_hits = 0;
    stats.point_cache_misses = 0;
    let frame = format!(
        "{:?}|{:?}|{:?}|{:?}",
        result.mesh_coordinate_space, result.frame, result.site_transform, result.building_transform
    );
    format!(
        "meshes={:016x} instances={:016x} frame={:016x} metadata={:016x} stats={:016x} n={}",
        fnv(&format!("{:?}", result.meshes)),
        fnv(&format!("{:?}", result.instances)),
        fnv(&frame),
        fnv(&serde_json::to_string(&result.metadata).expect("metadata serializes")),
        fnv(&serde_json::to_string(&stats).expect("stats serialize")),
        result.meshes.len(),
    )
}

/// One event a sink saw, with the facts the ordering contract is stated over.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Bootstrap { entities: usize },
    /// `ids` are the express ids of the emitted chunk, in order.
    Batch { ids: Vec<u32>, processed: usize, total: usize },
    ColorUpdate(Vec<(u32, [f32; 4])>),
}

impl Event {
    pub fn bootstrap(b: &QuickMetadataBootstrap) -> Self {
        Event::Bootstrap { entities: b.entity_count }
    }
}

/// The order-sensitive facts about a recorded trace, for assertions.
pub fn assert_ordering_contract(events: &[Event], what: &str) {
    let bootstraps: Vec<usize> = positions(events, |e| matches!(e, Event::Bootstrap { .. }));
    assert!(bootstraps.len() <= 1, "{what}: bootstrap fired {} times", bootstraps.len());
    let first_batch = positions(events, |e| matches!(e, Event::Batch { .. })).first().copied();
    if let (Some(b), Some(f)) = (bootstraps.first(), first_batch) {
        assert!(*b < f, "{what}: the bootstrap must precede the first batch");
    }
    let mut last = 0usize;
    for e in events {
        if let Event::Batch { processed, total, ids } = e {
            assert!(!ids.is_empty(), "{what}: an empty chunk was emitted");
            assert!(*processed >= last && processed <= total, "{what}: processed went backwards or past total");
            last = *processed;
        }
    }
    if let Some(update) = positions(events, |e| matches!(e, Event::ColorUpdate(_))).first() {
        let f = first_batch.unwrap_or_else(|| panic!("{what}: a colour update with no batch"));
        assert!(*update > f, "{what}: deferred colours replay after the first batch, never before");
    }
}

fn positions(events: &[Event], pred: impl Fn(&Event) -> bool) -> Vec<usize> {
    events.iter().enumerate().filter(|(_, e)| pred(e)).map(|(i, _)| i).collect()
}
