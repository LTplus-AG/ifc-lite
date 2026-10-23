// SPDX-License-Identifier: MPL-2.0
//! Peak memory of `plan::execute` on a large synthetic model.
//!
//! Generate a model once, then run the benchmark plan against it in a fresh
//! process, under `/usr/bin/time -l` (macOS) or `/usr/bin/time -v` (Linux),
//! and read the maximum resident set size. The source is read into memory
//! first, so the peak includes it: subtract the input size to get what the
//! executor itself adds.
//!
//! ```text
//! plan_memory gen <walls> <model.ifc>
//! plan_memory run <walls> <model.ifc> <out.ifc> [benchmark|geometry]
//! ```
//!
//! `benchmark` (the default) is the mixed plan in `plans.rs`; `geometry`
//! gives one wall in a hundred a new body.
//!
//! `walls` sizes the model (about 18 records a wall) and must match between
//! the two commands, since the plan is built from the model's layout.

// Shared with `tests/plan_output_pinned.rs`, which uses the parts this
// binary does not (the scenario plans, the quirks block).
#[allow(dead_code)]
#[path = "plans.rs"]
mod plans;
#[allow(dead_code)]
#[path = "synth.rs"]
mod synth;

use std::io::Write;
use std::time::Instant;

const SCHEMA: &str = "IFC2X3";
const STOREYS: u32 = 8;

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: plan_memory gen <walls> <model.ifc> | run <walls> <model.ifc> <out.ifc> [benchmark|geometry]";
    let (Some(mode), Some(walls)) = (args.get(1), args.get(2).and_then(|w| w.parse::<u32>().ok()).filter(|&w| w > 0)) else {
        eprintln!("{usage}");
        return std::process::ExitCode::FAILURE;
    };
    let layout = synth::Layout { walls, storeys: STOREYS, quirks: false };
    let which = args.get(5).map(String::as_str).unwrap_or("benchmark");
    match (mode.as_str(), args.get(3), args.get(4)) {
        ("gen", Some(path), None) => {
            let file = std::fs::File::create(path).expect("create the model file");
            let mut out = std::io::BufWriter::with_capacity(1 << 20, file);
            synth::write_model(&mut out, SCHEMA, &layout).expect("write the model");
            out.flush().expect("flush the model");
            let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            let records = ifc_lite_export::entity_count(&std::fs::read(path).expect("read back"));
            println!("wrote {path}: {bytes} bytes, {records} records");
        }
        ("run", Some(input), Some(output)) => {
            let source = std::fs::read(input).expect("read the model");
            let plan = match which {
                "benchmark" => plans::benchmark(&layout),
                "geometry" => plans::geometry(&layout, (walls / 100).max(1)),
                _ => {
                    eprintln!("{usage}");
                    return std::process::ExitCode::FAILURE;
                }
            };
            let file = std::fs::File::create(output).expect("create the output file");
            let started = Instant::now();
            let report = match ifc_lite_export::plan::execute(&source, &plan, file) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("failed: {e}");
                    return std::process::ExitCode::FAILURE;
                }
            };
            println!("input {} bytes", source.len());
            println!("dispositions {}", plan.dispositions.len());
            println!(
                "records {} written {} deleted {} patched {} refusals {} findings {}",
                report.total,
                report.written,
                report.deleted,
                report.patched,
                report.refusals.len(),
                report.findings.len()
            );
            println!("execute {:.2} s", started.elapsed().as_secs_f64());
        }
        _ => {
            eprintln!("{usage}");
            return std::process::ExitCode::FAILURE;
        }
    }
    std::process::ExitCode::SUCCESS
}
