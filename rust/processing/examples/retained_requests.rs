// SPDX-License-Identifier: MPL-2.0
//! build retained authored-extrusion requests for a model and summarize them.
//! cargo run -p ifc-lite-processing --example retained_requests -- model.ifc
//! No worker evaluates here: this reports encodable requests and refusals only.

use ifc_lite_processing::retained_requests::RetainedExtrusionSources;
use std::collections::BTreeMap;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os().nth(1).ok_or("pass an IFC file path")?;
    let content = std::fs::read(path)?;
    let sources = RetainedExtrusionSources::extract(&content, None);
    let mut qualifications = BTreeMap::<String, usize>::new();
    let (mut occurrences, mut payload_bytes) = (0, 0);
    for source in &sources.admitted {
        let request = source.prepare(1)?;
        *qualifications
            .entry(format!("{:?}", request.payload().qualification))
            .or_default() += 1;
        occurrences += source.occurrences().len();
        payload_bytes += request.payload().bytes.len();
    }
    let mut refusals = BTreeMap::<String, usize>::new();
    for refused in &sources.refused {
        // Family names only, e.g. "Source/InvalidSource", never the details.
        let debug = format!("{:?}", refused.refusal);
        let family = debug
            .split(['(', ' ', '"'])
            .filter(|part| !part.is_empty())
            .take(2);
        let family = match debug.strip_prefix("Source(") {
            Some(_) => family.collect::<Vec<_>>().join("/"),
            None => family.take(1).collect(),
        };
        *refusals.entry(family).or_default() += 1;
    }
    println!(
        "{}",
        serde_json::json!({
            "admitted_sources": sources.admitted.len(),
            "admitted_occurrences": occurrences,
            "qualifications": qualifications,
            "payload_bytes": payload_bytes,
            "refusals": refusals,
            "diagnostics": sources.diagnostics.len(),
            "note": "source-only retained requests; openings and enclosing booleans are not applied",
        })
    );
    Ok(())
}
