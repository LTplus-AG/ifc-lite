// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `ifc-lite-physics` — terminal entry point for rigid-body what-if
//! simulations.
//!
//! Loads an IFC file, runs the engine's geometry pipeline, then hands the
//! resulting meshes to `ifc-lite-physics::simulate`. Prints the result as
//! JSON (machine-readable) or a small human summary.
//!
//! Usage:
//!   ifc-lite-physics <file.ifc> --remove <expressId> [--remove <id>]...
//!                    [--anchor <id>]... [--duration <seconds>]
//!                    [--json]
//!
//! Designed for scripting. The companion JS CLI verb (`ifc-lite physics …`)
//! requires Node-side WASM bootstrapping work and is tracked separately.

use std::process::ExitCode;

use ifc_lite_engine::{physics, process_ifc_file, EngineResult};
use ifc_lite_engine::physics::SimulateOptions;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        print_help();
        return Ok(());
    }

    let mut file_path: Option<String> = None;
    let mut remove: Vec<u32> = Vec::new();
    let mut anchor: Vec<u32> = Vec::new();
    let mut duration: f32 = 3.0;
    let mut as_json = false;

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--remove" => {
                let value = iter.next().ok_or("--remove expects an express id")?;
                remove.push(parse_id(&value, "--remove")?);
            }
            "--anchor" => {
                let value = iter.next().ok_or("--anchor expects an express id")?;
                anchor.push(parse_id(&value, "--anchor")?);
            }
            "--duration" => {
                let value = iter.next().ok_or("--duration expects a number of seconds")?;
                let parsed: f32 = value
                    .parse::<f32>()
                    .map_err(|e| format!("invalid --duration '{value}': {e}"))?;
                if !parsed.is_finite() || parsed <= 0.0 {
                    return Err(format!(
                        "invalid --duration '{value}': must be a positive number of seconds",
                    ));
                }
                duration = parsed;
            }
            "--json" => as_json = true,
            "-h" | "--help" => {
                print_help();
                return Ok(());
            }
            other if other.starts_with("--") => {
                return Err(format!("unknown flag: {other}"));
            }
            other => {
                if file_path.is_some() {
                    return Err(format!("unexpected extra argument: {other}"));
                }
                file_path = Some(other.to_string());
            }
        }
    }

    let file_path = file_path.ok_or("missing positional <file.ifc>")?;

    let engine_result: EngineResult =
        process_ifc_file(&file_path).map_err(|e| format!("failed to process {file_path}: {e}"))?;
    if engine_result.meshes.is_empty() {
        return Err(format!(
            "no triangulated meshes in {file_path} (was geometry extraction skipped?)"
        ));
    }

    let mut options = SimulateOptions::default();
    options.remove = remove;
    options.anchor = anchor;
    options.duration_seconds = duration;

    let result = physics::simulate(&engine_result.meshes, &options);

    if as_json {
        let json = serde_json::to_string_pretty(&result)
            .map_err(|e| format!("failed to serialize result: {e}"))?;
        println!("{json}");
    } else {
        print_summary(&engine_result, &result);
    }

    Ok(())
}

fn parse_id(value: &str, flag: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|e| format!("invalid {flag} value '{value}': {e}"))
}

fn print_summary(engine: &EngineResult, result: &physics::SimulationResult) {
    println!("source: {} meshes", engine.meshes.len());
    println!(
        "world:  {} bodies, {} joints, {} anchored",
        result.bodies.len(),
        result.joints.len(),
        result.anchored.len(),
    );
    if !result.removed.is_empty() {
        println!("removed: {:?}", result.removed);
    }
    println!("falling: {} {:?}", result.falling.len(), preview(&result.falling));
    println!("tilted:  {} {:?}", result.tilted.len(), preview(&result.tilted));
    println!("stable:  {}", result.stable.len());
}

fn preview(ids: &[u32]) -> Vec<u32> {
    ids.iter().take(20).copied().collect()
}

fn print_help() {
    eprintln!(
        "ifc-lite-physics — rigid-body what-if simulations on IFC models\n\n\
         USAGE:\n  \
         ifc-lite-physics <file.ifc> [--remove <id>]... [--anchor <id>]... \\\n  \
                                     [--duration <seconds>] [--json]\n\n\
         OPTIONS:\n  \
         --remove <expressId>   IFC express id to delete before stepping (repeatable)\n  \
         --anchor <expressId>   Force this entity to stay fixed (repeatable)\n  \
         --duration <seconds>   Simulation duration (default 3.0)\n  \
         --json                 Emit the full SimulationResult as JSON\n  \
         -h, --help             Show this help\n\n\
         This is a plausibility check, not structural engineering: no bending,\n\
         buckling, or material yield. Run real analysis through an FEM tool fed\n\
         from IfcStructuralAnalysisModel."
    );
}
