// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Time the actual public symbolic API (#7779/#7914). The geometry perf probe
//! does not call it. Keep serialization and full-payload hashing outside timing.
//! Usage: symbolic_probe model.ifc [iterations]; use one iteration per process
//! for cold-process A/B, and interleave source-matched binaries on an idle host.

use ifc_lite_processing::extract_symbolic_data;
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("usage: symbolic_probe model.ifc [iterations]")?;
    let iterations: usize = args.next().unwrap_or_else(|| "5".to_owned()).parse()?;
    if iterations == 0 || args.next().is_some() {
        return Err("pass a positive iteration count and one fixture".into());
    }
    let source = std::fs::read(path)?;
    for iteration in 0..iterations {
        let start = Instant::now();
        let data = extract_symbolic_data(std::hint::black_box(&source));
        let elapsed_ns = start.elapsed().as_nanos();
        let payload = serde_json::to_vec(&data)?;
        let hash = payload.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
        println!("{}", serde_json::json!({
            "iteration": iteration,
            "elapsedNs": elapsed_ns,
            "inputBytes": source.len(),
            "polylineCount": data.polylines.len(),
            "circleCount": data.circles.len(),
            "fillCount": data.fills.len(),
            "textCount": data.texts.len(),
            "gridCount": data.grid_axes.len(),
            "symbolicJsonBytes": payload.len(),
            "symbolicJsonFnv1a64": format!("{hash:016x}"),
        }));
    }
    Ok(())
}
