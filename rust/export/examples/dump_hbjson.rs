// SPDX-License-Identifier: MPL-2.0
//! Dump HBJSON for an IFC file: `cargo run --example dump_hbjson -- <file.ifc> [name]`
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.get(1) else {
        eprintln!("usage: dump_hbjson <file.ifc> [name]");
        std::process::exit(2);
    };
    let bytes = std::fs::read(path).expect("read ifc");
    let name = args.get(2).cloned().unwrap_or_else(|| "model".to_string());
    let (json, stats) =
        ifc_lite_export::export_hbjson_with_stats(&bytes, &ifc_lite_export::HbjsonOptions { name, tolerance: 0.01 });
    eprintln!(
        "IfcSpace: {} | rooms: {} | skipped: {} | windows: {} | doors: {} | shades: {} | constructions: {} | interior-adj: {}",
        stats.spaces, stats.rooms, stats.skipped, stats.apertures, stats.doors, stats.shades, stats.constructions, stats.interior_adjacencies
    );
    print!("{json}");
}
