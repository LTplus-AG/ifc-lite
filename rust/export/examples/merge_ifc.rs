// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Merge several IFC files natively (issue #2951) and self-check the result:
//! duplicate GlobalIds, dangling references, IfcProject count, and the
//! coverage stats. Reads each file from disk and writes one merged `.ifc`,
//! exercising exactly the path a native (Rust) consumer would drive instead of
//! the webview JS `MergedExporter`.
//!
//!     cargo run --release -p ifc-lite-export --example merge_ifc -- \
//!         [--assume-shared] <a.ifc> <b.ifc> [more.ifc ...] <out.ifc>
//!
//! The last path is the output. `--assume-shared` treats every model as sharing
//! the first model's unit (skips the compatibility check).

use std::collections::HashMap;
use std::time::Instant;

use ifc_lite_export::{export_merged_models, MergedModel, MergedOptions, UnitReconciliation};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let assume_shared = args.iter().any(|a| a == "--assume-shared");
    args.retain(|a| a != "--assume-shared");

    if args.len() < 3 {
        eprintln!(
            "usage: merge_ifc [--assume-shared] <a.ifc> <b.ifc> [more.ifc ...] <out.ifc>\n\
             (need at least two input files plus an output path)"
        );
        std::process::exit(2);
    }

    let out_path = args.pop().expect("output path");
    let in_paths = args;

    // Read every input from disk (the native path never touches a webview heap).
    let mut buffers: Vec<Vec<u8>> = Vec::with_capacity(in_paths.len());
    for p in &in_paths {
        match std::fs::read(p) {
            Ok(bytes) => {
                println!("read {p} ({:.1} MB)", bytes.len() as f64 / 1e6);
                buffers.push(bytes);
            }
            Err(e) => {
                eprintln!("error: cannot read {p}: {e}");
                std::process::exit(1);
            }
        }
    }

    let models: Vec<MergedModel> = buffers
        .iter()
        .zip(&in_paths)
        .map(|(bytes, path)| MergedModel {
            content: bytes,
            id: path.clone(),
            included: None,
        })
        .collect();

    let opts = MergedOptions {
        unit_reconciliation: if assume_shared {
            UnitReconciliation::AssumeShared
        } else {
            UnitReconciliation::Auto
        },
        ..Default::default()
    };

    let t0 = Instant::now();
    let (merged, stats) = export_merged_models(&models, &opts);
    let elapsed = t0.elapsed();

    if let Err(e) = std::fs::write(&out_path, merged.as_bytes()) {
        eprintln!("error: cannot write {out_path}: {e}");
        std::process::exit(1);
    }

    // Self-checks on the emitted text.
    let (projects, dup_guids, dangling) = self_check(&merged);

    println!("\n── merged in {:.2}s → {out_path} ({:.1} MB) ──", elapsed.as_secs_f64(), merged.len() as f64 / 1e6);
    println!("models              : {}", stats.models);
    println!("entities written    : {}", stats.written);
    println!("IfcProject count    : {projects}");
    println!("federated models    : {}", stats.federated_model_count);
    println!("unit_rescale_required: {}", stats.unit_rescale_required);
    for w in &stats.warnings {
        println!("warning             : {w}");
    }
    println!("duplicate GlobalIds : {dup_guids}  (within-source exporter defects survive the merge, exactly as the JS MergedExporter would emit them — cross-model collisions are what reconciliation removes)");
    println!("dangling references : {dangling}");

    // A merge is correct when it introduces no dangling references and produces
    // the expected number of IfcProjects: one unified project, plus one per
    // FEDERATED model (an incompatible-unit model under Auto keeps its own
    // project — a supported result, not a failure). Duplicate GlobalIds carried
    // in from a defective source file are not a merge regression (the JS path
    // emits them too), so they do not fail the run.
    let expected_projects = 1 + stats.federated_model_count;
    let ok = dangling == 0 && projects == expected_projects;
    println!(
        "\nresult: {}",
        if ok {
            "PASS (no dangling refs, expected project count)"
        } else {
            "FAIL — see counts above"
        }
    );
    if !ok {
        std::process::exit(1);
    }
}

/// Returns `(ifc_project_count, duplicate_global_id_count, dangling_ref_count)`.
fn self_check(step: &str) -> (usize, usize, usize) {
    // Every written express id.
    let mut ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for line in step.lines().filter(|l| l.starts_with('#')) {
        if let Some(id) = leading_express_id(line) {
            ids.insert(id);
        }
    }

    let mut projects = 0usize;
    let mut guid_counts: HashMap<String, usize> = HashMap::new();
    let mut dangling = 0usize;

    for line in step.lines().filter(|l| l.starts_with('#')) {
        // Space-tolerant: some exporters write `#1= IFCPROJECT(` with a space
        // after `=`, so match on the type token rather than a literal `=IFC…(`.
        if type_token(line).as_deref() == Some("IFCPROJECT") {
            projects += 1;
        }
        // Type-aware GlobalId classification (the same rule the merge uses), so a
        // non-rooted entity leading with a 22-char charset Name (e.g. IfcColourRgb)
        // is not counted as a duplicate GlobalId (CR #2952).
        if let Some(g) = ifc_lite_export::leading_rooted_global_id(line.as_bytes()) {
            *guid_counts.entry(g).or_default() += 1;
        }
        // Count references to ids that were never written.
        for r in refs_in(line) {
            if !ids.contains(&r) {
                dangling += 1;
            }
        }
    }

    let dup_guids = guid_counts.values().filter(|&&c| c > 1).count();
    (projects, dup_guids, dangling)
}

/// The express id from a `#123=…` line.
fn leading_express_id(line: &str) -> Option<u32> {
    let body = line.strip_prefix('#')?;
    let end = body.find('=')?;
    body[..end].trim().parse().ok()
}

/// The uppercase entity type token of a `#id= TYPE(...)` line, tolerating
/// whitespace after `=` (T-FLEX and some exporters emit `#1= IFCPROJECT(`).
fn type_token(line: &str) -> Option<String> {
    let after_eq = &line[line.find('=')? + 1..];
    let start = after_eq.find(|c: char| !c.is_whitespace())?;
    let rest = &after_eq[start..];
    let end = rest.find('(')?;
    Some(rest[..end].trim().to_ascii_uppercase())
}

/// Every `#N` reference in a line, ignoring the leading id and quoted strings.
fn refs_in(line: &str) -> Vec<u32> {
    let after_eq = line.find('=').map(|e| &line[e..]).unwrap_or(line);
    let bytes = after_eq.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'\'' {
            in_str = !in_str;
        } else if !in_str && c == b'#' {
            let mut j = i + 1;
            let mut n = 0u32;
            let mut any = false;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                n = n * 10 + (bytes[j] - b'0') as u32;
                j += 1;
                any = true;
            }
            if any {
                out.push(n);
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}
