//! What does writing an IFC file back out cost, held or streamed?
//!
//! `export_step` returns the whole output as a `String`, so a 1 GB model needs
//! the source, the index, and a gigabyte of output live at once — and a `String`
//! reaching a gigabyte reallocates its way there, so the peak is worse than the
//! total. `export_step_to_writer` emits each record as it is read. Same file,
//! same options, one run each, so the two peaks are comparable.
//!
//! ```text
//! step_writer_cost <file.ifc> held|streamed <out.ifc>
//! ```
use ifc_lite_export::{export_step_to_writer, export_step_with_stats, StepOptions};

fn main() -> std::process::ExitCode {
    let input = std::env::args().nth(1).expect("usage: step_writer_cost <file.ifc> held|streamed <out>");
    let mode = std::env::args().nth(2).unwrap_or_else(|| "streamed".into());
    let out = std::env::args().nth(3).expect("an output path");
    let content = std::fs::read(&input).expect("read");
    println!("input {} bytes", content.len());
    let opts = StepOptions::default();
    let stats = match mode.as_str() {
        "held" => {
            let (text, stats) = export_step_with_stats(&content, &opts);
            println!("output {} bytes", text.len());
            std::fs::write(&out, text.as_bytes()).expect("write");
            stats
        }
        "streamed" => {
            let file = std::fs::File::create(&out).expect("create");
            let mut w = std::io::BufWriter::with_capacity(1 << 20, file);
            let stats = match export_step_to_writer(&content, &opts, &mut w) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("failed: {e}");
                    return std::process::ExitCode::FAILURE;
                }
            };
            // Flushed before the size is read, and the error surfaced: a
            // `BufWriter` dropped without flushing loses its last buffer and
            // reports success, which is a truncated file and a zero exit.
            if let Err(e) = std::io::Write::flush(&mut w) {
                eprintln!("failed to flush: {e}");
                return std::process::ExitCode::FAILURE;
            }
            drop(w);
            println!("output {} bytes", std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0));
            stats
        }
        other => panic!("mode is held or streamed, not {other}"),
    };
    println!("mode {mode}");
    println!("records {} of {}", stats.written, stats.total);
    std::process::ExitCode::SUCCESS
}
