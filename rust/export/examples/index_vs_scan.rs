// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Split `relationships` and `extract_georeferencing` into the two costs they
//! actually pay, so a fix aims at the bigger one.
//!
//! Both walk every entity with an `EntityScanner`, and that scan is the larger
//! half. An entity index is the smaller one, which is why "share the index" is
//! worth doing and is not worth overselling.
//!
//! Read the two rows against `bare type-name scan`:
//!
//! * `relationships()` builds no index and should sit near the bare scan. If it
//!   drifts well above, someone has given it one again.
//! * `extract_georeferencing()` needs an index, because the extractor resolves
//!   its references by id. It builds one unless the caller passes it in through
//!   `extract_georeferencing_with_index`.
//!
//!     cargo run --release -p ifc-lite-export --example index_vs_scan -- <file.ifc>

use std::time::Instant;

use ifc_lite_core::{build_entity_index, EntityScanner};
use ifc_lite_processing::build_entity_index_parallel;

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// Best of `n`, to shave scheduler noise the way `perf_probe` does.
fn best<F: FnMut() -> f64>(n: usize, mut f: F) -> f64 {
    (0..n).map(|_| f()).fold(f64::INFINITY, f64::min)
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: index_vs_scan <file.ifc>");
    let content = std::fs::read(&path).expect("read input");
    let mb = content.len() as f64 / (1024.0 * 1024.0);

    let serial = best(3, || {
        let t = Instant::now();
        let idx = build_entity_index(&content[..]);
        let e = ms(t);
        std::hint::black_box(&idx);
        e
    });

    let parallel = best(3, || {
        let t = Instant::now();
        let idx = build_entity_index_parallel(&content[..]);
        let e = ms(t);
        std::hint::black_box(&idx);
        e
    });

    // The bare scan both helpers run on top of their index: iterate every entity
    // and look at its type name, which is all the candidate collection does.
    let scan = best(3, || {
        let t = Instant::now();
        let mut n = 0usize;
        let mut scanner = EntityScanner::new(&content);
        while let Some((_id, type_name, _s, _e)) = scanner.next_entity() {
            if matches!(
                type_name,
                "IFCMAPCONVERSION"
                    | "IFCPROJECTEDCRS"
                    | "IFCPROPERTYSET"
                    | "IFCSITE"
                    | "IFCRELAGGREGATES"
                    | "IFCRELCONTAINEDINSPATIALSTRUCTURE"
                    | "IFCRELDEFINESBYTYPE"
            ) {
                n += 1;
            }
        }
        let e = ms(t);
        std::hint::black_box(n);
        e
    });

    let rel = best(3, || {
        let t = Instant::now();
        let r = ifc_lite_export::relationships(&content);
        let e = ms(t);
        std::hint::black_box(&r);
        e
    });

    let geo = best(3, || {
        let t = Instant::now();
        let g = ifc_lite_processing::extract_georeferencing(&content[..]);
        let e = ms(t);
        std::hint::black_box(&g);
        e
    });

    println!("{path}  ({mb:.1} MB)");
    println!("  build_entity_index (serial)     {serial:8.1} ms");
    println!("  build_entity_index_parallel     {parallel:8.1} ms");
    println!("  bare type-name scan             {scan:8.1} ms");
    println!("  ---");
    println!("  relationships()                 {rel:8.1} ms   index is {:4.1}% of it", 100.0 * parallel / rel);
    println!("  extract_georeferencing()        {geo:8.1} ms   index is {:4.1}% of it", 100.0 * parallel / geo);
    println!("  ---");
    println!(
        "  index a caller can still save   {:8.1} ms  ({:.1}% of the two helpers' {:.1} ms)",
        parallel,
        100.0 * parallel / (rel + geo),
        rel + geo
    );
}
