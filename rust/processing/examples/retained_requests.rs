// SPDX-License-Identifier: MPL-2.0
//! build retained authored-source requests (extrusions and swept disks) for a
//! model and summarize them per family.
//! cargo run -p ifc-lite-processing --example retained_requests -- model.ifc
//! No worker evaluates here: this reports encodable requests and refusals only.

use ifc_lite_processing::retained_requests::RetainedSources;
use std::collections::BTreeMap;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os().nth(1).ok_or("pass an IFC file path")?;
    let content = std::fs::read(path)?;
    let mut families = serde_json::Map::new();
    for (family, sources) in [
        ("extrusion", RetainedSources::extrusions(&content, None)),
        ("swept_disk", RetainedSources::swept_disks(&content, None)),
    ] {
        families.insert(family.into(), summary(&sources)?);
    }
    families.insert(
        "note".into(),
        "source-only retained requests; openings and enclosing booleans are not applied".into(),
    );
    println!("{}", serde_json::Value::Object(families));
    Ok(())
}

fn summary(sources: &RetainedSources) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
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
    Ok(serde_json::json!({
        "admitted_sources": sources.admitted.len(),
        "admitted_occurrences": occurrences,
        "qualifications": qualifications,
        "payload_bytes": payload_bytes,
        "refusals": refusals,
        "diagnostics": sources.diagnostics.len(),
    }))
}
