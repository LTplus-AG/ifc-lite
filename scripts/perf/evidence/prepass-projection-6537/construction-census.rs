// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unshipped #6537 diagnostic. Uses the canonical scanner/parser/converter.
//! Separates relation token parsing from AttributeValue construction, without
//! changing any production decoder, cache, prepass or geometry path.
//! Retained-token conversion timings are a feasibility screen, NOT worker-pool
//! load timings or proof that a projected production decoder would be faster.

use ifc_lite_core::{parse_entity, AttributeValue, EntityScanner};
use serde::Serialize;
use std::{collections::BTreeMap, hint::black_box, time::Instant};

#[derive(Default, Serialize)]
struct Construction {
    attribute_nodes: usize,
    strings: usize,
    string_bytes: usize,
    lists: usize,
    references: usize,
}

fn census(values: &[AttributeValue], out: &mut Construction) {
    let mut pending: Vec<_> = values.iter().collect();
    while let Some(value) = pending.pop() {
        out.attribute_nodes += 1;
        match value {
            AttributeValue::String(value) | AttributeValue::Enum(value) => {
                out.strings += 1;
                out.string_bytes += value.len();
            }
            AttributeValue::List(values) => {
                out.lists += 1;
                pending.extend(values.iter());
            }
            AttributeValue::EntityRef(_) => out.references += 1,
            _ => {}
        }
    }
}

#[derive(Serialize)]
struct Group {
    records: usize,
    record_bytes: usize,
    maximum_original_offset: usize,
    attributes: usize,
    unused_attributes_for_reference_pair: usize,
    constructed: Construction,
    unused_constructed: Construction,
    canonical_token_parse_ms: f64,
    full_conversion_ms: Vec<f64>,
    reference_pair_conversion_ms: Option<Vec<f64>>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut reports = Vec::new();
    for path in std::env::args().skip(1) {
        let data = std::fs::read(&path)?;
        let mut scanner = EntityScanner::new(&data);
        let mut spans: BTreeMap<String, Vec<(usize, usize)>> = BTreeMap::new();
        let mut total_entities = 0;
        let scan = Instant::now();
        while let Some((_id, name, start, end)) = scanner.next_entity() {
            total_entities += 1;
            if ["IFCRELVOIDSELEMENT", "IFCRELFILLSELEMENT", "IFCRELASSOCIATESMATERIAL",
                "IFCRELAGGREGATES", "IFCRELDEFINESBYTYPE", "IFCSTYLEDITEM"]
                .iter().any(|candidate| name.eq_ignore_ascii_case(candidate)) {
                spans.entry(name.to_ascii_uppercase()).or_default().push((start, end));
            }
        }
        let scan_ms = scan.elapsed().as_secs_f64() * 1000.0;
        let oversized = scanner.skipped_oversized_ids();
        let malformed = scanner.malformed_record_starts().len();
        ifc_lite_core::report_scan_diagnostics(oversized, malformed > 0);
        let mut groups = BTreeMap::new();
        for (name, records) in spans {
            let parse_start = Instant::now();
            let tokens: Vec<_> = records.iter().map(|&(start, end)| {
                parse_entity(&data[start..end]).map(|(_id, _kind, tokens)| tokens)
            }).collect::<ifc_lite_core::Result<_>>()?;
            let canonical_token_parse_ms = parse_start.elapsed().as_secs_f64() * 1000.0;
            let pair = matches!(name.as_str(), "IFCRELVOIDSELEMENT" | "IFCRELFILLSELEMENT");
            let mut full_conversion_ms = Vec::new();
            let mut reference_pair_conversion_ms = pair.then(Vec::new);
            // Interleave conversion orders; include allocations and destruction.
            // Five observations are retained, never reduced to best-of-N.
            for iteration in 0..5 {
                for full in if iteration % 2 == 0 { [true, false] } else { [false, true] } {
                    if !full && !pair { continue; }
                    let start = Instant::now();
                    for record in &tokens {
                        let values: Vec<_> = record.iter().enumerate()
                            .filter(|(index, _)| full || *index == 4 || *index == 5)
                            .map(|(_, token)| AttributeValue::from_token(token)).collect();
                        black_box(values);
                    }
                    let ms = start.elapsed().as_secs_f64() * 1000.0;
                    if full { full_conversion_ms.push(ms); }
                    else if let Some(samples) = &mut reference_pair_conversion_ms { samples.push(ms); }
                }
            }
            let mut constructed = Construction::default();
            let mut unused_constructed = Construction::default();
            for record in &tokens {
                let values: Vec<_> = record.iter().map(AttributeValue::from_token).collect();
                census(&values, &mut constructed);
                if pair {
                    let unused: Vec<_> = values.into_iter().enumerate()
                        .filter(|(index, _)| *index != 4 && *index != 5)
                        .map(|(_, value)| value).collect();
                    census(&unused, &mut unused_constructed);
                }
            }
            groups.insert(name, Group {
                records: records.len(),
                record_bytes: records.iter().map(|&(start, end)| end - start).sum(),
                maximum_original_offset: records.iter().map(|&(_, end)| end).max().unwrap_or(0),
                attributes: tokens.iter().map(Vec::len).sum(),
                unused_attributes_for_reference_pair: if pair {
                    tokens.iter().map(|record| record.len().saturating_sub(2)).sum()
                } else { 0 },
                constructed, unused_constructed, canonical_token_parse_ms,
                full_conversion_ms, reference_pair_conversion_ms,
            });
        }
        reports.push(serde_json::json!({
            "path": path, "bytes": data.len(), "entities": total_entities,
            "canonicalScanMs": scan_ms, "groups": groups,
            "oversizedRecordsRefused": oversized, "malformedRecordsRefused": malformed,
            "scope": "Native canonical parser/construction feasibility census only. Retained-token conversions omit decoder caches and full prepass; original offsets are not a worker access union. No end-to-end worker-pool/performance/packet-safety claim."
        }));
    }
    if reports.is_empty() { return Err("Provide at least one real IFC fixture path".into()); }
    println!("{}", serde_json::to_string_pretty(&reports)?);
    Ok(())
}
