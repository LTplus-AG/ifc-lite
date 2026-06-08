// M0 instrumentation: measure the REAL CSG-kernel op stream over a corpus —
// how many boolean ops reach subtract/union/intersection/clip, and their
// operand-triangle-count distribution (the arrangement-cost driver). The
// analytic AABB box-clip path never reaches the kernel, so this is the genuine
// heavy-path workload the pure-Rust arrangement kernel must handle no slower.
//
// Usage: cargo run -q -p ifc-lite-processing --example csg_op_census -- <a.ifc> <b.ifc> ...
use ifc_lite_geometry::csg::{reset_csg_census, take_csg_census, CsgOpRecord};
use ifc_lite_processing::process_geometry;
use std::fs;

fn bucket(n: u32) -> usize {
    match n {
        0..=4 => 0,
        5..=12 => 1,
        13..=32 => 2,
        33..=128 => 3,
        129..=512 => 4,
        _ => 5,
    }
}
const BUCKETS: [&str; 6] = ["0-4", "5-12", "13-32", "33-128", "129-512", "513+"];
const OPS: [&str; 4] = ["subtract", "union", "intersect", "clip"];

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    let mut all: Vec<CsgOpRecord> = Vec::new();
    for f in &files {
        let content = match fs::read_to_string(f) {
            Ok(c) => c,
            Err(_) => {
                eprintln!("  skip (unreadable): {f}");
                continue;
            }
        };
        reset_csg_census();
        let _ = process_geometry(&content);
        let recs = take_csg_census();
        let name = f.rsplit('/').next().unwrap_or(f);
        eprintln!("  {name}: {} csg ops", recs.len());
        all.extend(recs);
    }

    let total = all.len();
    println!("\n==== CSG OP CENSUS  ({total} kernel ops over {} models) ====", files.len());
    if total == 0 {
        println!("(no ops — fixtures missing or no booleans)");
        return;
    }

    // Per-op-type counts.
    let mut op_counts = [0usize; 4];
    for r in &all {
        if (r.op as usize) < 4 {
            op_counts[r.op as usize] += 1;
        }
    }
    print!("by op: ");
    for i in 0..4 {
        print!("{}={} ", OPS[i], op_counts[i]);
    }
    println!();

    // Operand max-tris histogram (the cost driver = the larger operand).
    let mut hist = [0usize; 6];
    let mut maxop = 0u32;
    let mut heavy = 0usize; // max operand > 128 tris (BSP cap rejects these today)
    for r in &all {
        let m = r.a_tris.max(r.b_tris);
        hist[bucket(m)] += 1;
        maxop = maxop.max(m);
        if m > 128 {
            heavy += 1;
        }
    }
    println!("\nmax-operand-tris distribution:");
    for i in 0..6 {
        let pct = 100.0 * hist[i] as f64 / total as f64;
        println!("  {:>8}: {:>6}  ({:>5.1}%)  {}", BUCKETS[i], hist[i], pct, "#".repeat((pct / 2.0) as usize));
    }
    println!("\nworst-case operand: {maxop} tris");
    println!(
        "HEAVY ops (>128 tris, BSP-cap-rejected today): {heavy}  ({:.1}% of kernel ops)",
        100.0 * heavy as f64 / total as f64
    );
    println!(
        "TRIVIAL ops (<=12 tris, box/prism cutters): {}  ({:.1}%)",
        hist[0] + hist[1],
        100.0 * (hist[0] + hist[1]) as f64 / total as f64
    );
}
