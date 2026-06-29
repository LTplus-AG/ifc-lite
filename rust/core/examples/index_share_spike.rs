// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! SPIKE: validate sharing the entity index across geometry workers instead of
//! each worker rebuilding it. Each WASM geometry worker calls
//! `build_entity_index(content)` in its own realm; for a 722 MB / 12.6 M-entity
//! model that is the dominant time (pre-first-geometry gap) AND memory (3x the
//! index) cost. This measures whether a SHARED, pre-built form (a sorted
//! `(id, start, end)` array a worker can binary-search) beats rebuilding the
//! FxHashMap per worker, on both axes.
//!
//! Run: cargo run --release -p ifc-lite-core --example index_share_spike -- <file.ifc>

use ifc_lite_core::{build_entity_index, EntityScanner};
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("usage: index_share_spike <file.ifc>");
    let content = std::fs::read(&path).expect("read file");
    let mb = content.len() as f64 / 1e6;
    println!("file: {path} ({mb:.1} MB)");

    // --- 1. Full build_entity_index (what each worker does today) ---
    let t = Instant::now();
    let index = build_entity_index(&content);
    let build_ms = t.elapsed().as_secs_f64() * 1000.0;
    let n = index.len();
    println!("\n[today: per-worker rebuild]");
    println!("  build_entity_index: {build_ms:.0} ms  ({n} entities)");

    // --- 2. Scan-only (no insert) — isolates scan vs hashmap-insert cost ---
    let t = Instant::now();
    let mut scan_count = 0usize;
    let mut scanner = EntityScanner::new(&content);
    let mut checksum = 0u64; // keep the loop from being optimized away
    while let Some((id, _ty, start, end)) = scanner.next_entity() {
        scan_count += 1;
        checksum = checksum.wrapping_add(id as u64 ^ (start as u64) ^ (end as u64));
    }
    let scan_ms = t.elapsed().as_secs_f64() * 1000.0;
    let insert_ms = build_ms - scan_ms;
    println!("  of which: scan {scan_ms:.0} ms  +  hashmap-insert {insert_ms:.0} ms  (scan_count={scan_count}, cs={checksum:x})");

    // --- 3. Shareable form: sorted Vec<(id, start, end)> a worker binary-searches ---
    // Offsets fit in u32 for files < 4 GB, so 12 bytes/entry exactly (vs the
    // FxHashMap's ~24-28 bytes/entry + per-worker duplication).
    let t = Instant::now();
    let mut flat: Vec<(u32, u32, u32)> = Vec::with_capacity(n);
    let mut scanner = EntityScanner::new(&content);
    while let Some((id, _ty, start, end)) = scanner.next_entity() {
        flat.push((id, start as u32, end as u32));
    }
    flat.sort_unstable_by_key(|e| e.0);
    let flat_build_ms = t.elapsed().as_secs_f64() * 1000.0;
    println!("\n[shared: build the sorted array ONCE (prepass), workers reuse it]");
    println!("  scan + sort to flat array: {flat_build_ms:.0} ms");

    // --- 4. Deserialize cost for a worker: zero-copy view of a shared byte buffer ---
    // A worker receiving the array via SharedArrayBuffer does NO rebuild — it just
    // views the bytes. Simulate the only per-worker cost: nothing (the array is
    // already sorted + shared). Lookup is binary_search. Compare lookup cost so we
    // know binary-search is acceptable vs the O(1) hashmap.
    let sample: Vec<u32> = flat.iter().step_by(7).map(|e| e.0).collect(); // ~1.8M ids
    let t = Instant::now();
    let mut hit_hash = 0u64;
    for &id in &sample {
        if let Some(&(s, _e)) = index.get(&id) {
            hit_hash = hit_hash.wrapping_add(s as u64);
        }
    }
    let hash_lookup_ms = t.elapsed().as_secs_f64() * 1000.0;

    let t = Instant::now();
    let mut hit_bin = 0u64;
    for &id in &sample {
        if let Ok(pos) = flat.binary_search_by_key(&id, |e| e.0) {
            hit_bin = hit_bin.wrapping_add(flat[pos].1 as u64);
        }
    }
    let bin_lookup_ms = t.elapsed().as_secs_f64() * 1000.0;
    println!("\n[lookup A/B over {} ids]", sample.len());
    println!("  FxHashMap.get:        {hash_lookup_ms:.1} ms  (cs={hit_hash:x})");
    println!("  sorted binary_search: {bin_lookup_ms:.1} ms  (cs={hit_bin:x})");

    // --- 5. Memory: per-worker hashmap (x3) vs one shared sorted array ---
    // FxHashMap (hashbrown) stores ~ (key + val) / load_factor + 1 control byte.
    // entry = u32 key (padded to 8) + (usize,usize)=16 -> 24 bytes; /0.875 + 1B ~= 28.
    let hashmap_bytes = n as f64 * 28.0;
    let flat_bytes = n as f64 * 12.0; // (u32,u32,u32), no padding
    let workers = 3.0;
    println!("\n[memory estimate, {n} entities]");
    // REALITY: separate WASM realms have no shared linear memory, so each worker
    // COPIES the flat array into its own heap — 3x152, NOT a single shared 1x152.
    // The win is the smaller per-worker footprint (flat vs hashmap), not sharing.
    println!("  per-worker FxHashMap:  {:.0} MB  x{workers:.0} = {:.0} MB",
        hashmap_bytes / 1e6, hashmap_bytes * workers / 1e6);
    println!("  per-worker flat array: {:.0} MB  x{workers:.0} = {:.0} MB (each realm copies it)",
        flat_bytes / 1e6, flat_bytes * workers / 1e6);
    println!("  => saves ~{:.0} MB peak ({:.1}x less index memory per worker)",
        (hashmap_bytes - flat_bytes) * workers / 1e6,
        hashmap_bytes / flat_bytes);
    println!("  (ideal 1x-shared = {:.0} MB / ~{:.0} MB saved, but needs shared wasm memory)",
        flat_bytes / 1e6, (hashmap_bytes * workers - flat_bytes) / 1e6);

    // --- Verdict signals ---
    println!("\n[verdict signals]");
    println!("  build dominated by: {}",
        if insert_ms > scan_ms { "HASHMAP INSERT (sharing must avoid the rebuild => binary-search a shared array)" }
        else { "SCAN (sharing a pre-scanned array still needs a per-worker map build unless we binary-search)" });
    println!("  binary_search vs hashmap lookup ratio: {:.1}x", bin_lookup_ms / hash_lookup_ms.max(0.001));
}
