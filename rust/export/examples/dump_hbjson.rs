// SPDX-License-Identifier: MPL-2.0
//! Dump HBJSON for an IFC file: `cargo run --example dump_hbjson -- <file.ifc> [name]`
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).expect("read ifc");
    let name = args.get(2).cloned().unwrap_or_else(|| "model".to_string());
    let (json, stats) =
        ifc_lite_export::export_hbjson_with_stats(&bytes, &ifc_lite_export::HbjsonOptions { name, tolerance: 0.01 });
    eprintln!(
        "IfcSpace: {} | rooms: {} | skipped (P5): {} | windows: {} | doors: {} | shades: {}",
        stats.spaces, stats.rooms, stats.skipped, stats.apertures, stats.doors, stats.shades
    );
    print!("{json}");
}
