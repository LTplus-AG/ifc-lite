// Scratch repro for issue #2937 — not part of the crate's public surface,
// not committed as a test. Builds N annotations that all share one 24-level
// mapped-item fan-out DAG (the same shape as
// `an_acyclic_dag_is_bounded_by_total_work_not_by_depth` in
// `symbolic/items_cycle_tests.rs`) and runs them through
// `extract_symbolic_data`, the real per-request entry point. Run under
// `/usr/bin/time -l` to capture peak RSS.
//
// Usage: cargo run --release -p ifc-lite-processing --example repro_2937 -- <N>

use ifc_lite_processing::extract_symbolic_data;

fn wrap(body: &str) -> String {
    format!("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n{body}ENDSEC;\nEND-ISO-10303-21;\n")
}

/// The shared 24-level fan-out chain, rooted at representation map #1000.
/// Two mapped items per level, both pointing at the next level: 2^24 paths
/// to the single leaf polyline if nothing bounds total work.
fn shared_fanout_chain() -> String {
    let levels = 24usize;
    let mut lines = String::new();
    for i in 0..levels {
        let map = 1000 + i * 10;
        let repr = map + 1;
        let a = map + 2;
        let b = map + 3;
        let next_map = if i + 1 < levels { 1000 + (i + 1) * 10 } else { 90_000 };
        lines.push_str(&format!("#{map}=IFCREPRESENTATIONMAP($,#{repr});\n"));
        lines.push_str(&format!("#{repr}=IFCSHAPEREPRESENTATION($,$,$,(#{a},#{b}));\n"));
        lines.push_str(&format!("#{a}=IFCMAPPEDITEM(#{next_map},$);\n"));
        lines.push_str(&format!("#{b}=IFCMAPPEDITEM(#{next_map},$);\n"));
    }
    lines.push_str("#90000=IFCREPRESENTATIONMAP($,#90001);\n");
    lines.push_str("#90001=IFCSHAPEREPRESENTATION($,$,$,(#90010));\n");
    lines.push_str("#90010=IFCPOLYLINE((#90011,#90012));\n");
    lines.push_str("#90011=IFCCARTESIANPOINT((0.,0.));\n#90012=IFCCARTESIANPOINT((1.,1.));\n");
    lines
}

/// N annotations, each a fresh top-level IfcMappedItem into the SAME shared
/// chain rooted at #1000 -- the shape that gives each top-level item its own
/// fresh MAX_ITEM_REVISITS budget under the current per-item ItemWalk.
fn n_annotations(n: usize) -> String {
    let mut lines = shared_fanout_chain();
    // Express ids for annotation N: base = 200000 + n*4
    for k in 0..n {
        let base = 200_000 + k * 4;
        let ann = base;
        let pds = base + 1;
        let rep = base + 2;
        let item = base + 3;
        lines.push_str(&format!("#{item}=IFCMAPPEDITEM(#1000,$);\n"));
        lines.push_str(&format!("#{rep}=IFCSHAPEREPRESENTATION($,'Annotation',$,(#{item}));\n"));
        lines.push_str(&format!("#{pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\n"));
        lines.push_str(&format!(
            "#{ann}=IFCANNOTATION($,$,$,$,$,$,#{pds});\n"
        ));
    }
    wrap(&lines)
}

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let content = n_annotations(n);
    eprintln!("fixture: {n} annotations, {} bytes", content.len());
    let t0 = std::time::Instant::now();
    let out = extract_symbolic_data(&content);
    let elapsed = t0.elapsed();
    println!(
        "n={n} bytes={} polylines={} elapsed={:?}",
        content.len(),
        out.polylines.len(),
        elapsed
    );
}
