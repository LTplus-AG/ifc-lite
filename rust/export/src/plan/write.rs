// SPDX-License-Identifier: MPL-2.0
//! Writing a resolved plan: one pass over the source in file order, each
//! record written as it is read and validated as it is written. Nothing the
//! size of the output is held.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;

use rustc_hash::{FxHashMap, FxHashSet};

use crate::StepOptions;

use super::index::FileIndex;
use super::source_text;
use super::resolve::Resolution;
use super::removal::{Removal, RemovalReason};
use super::types::{ExportPlan, PlanError, ValidationFinding, WriteReport};
use super::validate::{duplicate_pset_names, StreamValidator};

pub(crate) fn write_output<W: Write>(
    index: &FileIndex,
    schema: &str,
    plan: &ExportPlan,
    resolution: Resolution,
    out: W,
) -> Result<WriteReport, PlanError> {
    let source = index.content();
    let mut out = std::io::BufWriter::with_capacity(1 << 20, out);
    // The exporting application is the originating system, this crate the
    // toolkit that wrote the exchange structure, and the change time the
    // file's time stamp.
    let mut header_opts = StepOptions {
        author: plan.context.author.clone(),
        organization: plan.context.organization.clone(),
        // Without an application; `stamp_header` replaces it with the
        // application's change time when there is one.
        time_stamp: plan.context.time_stamp.clone(),
        filename: plan.context.file_name.clone(),
        ..Default::default()
    };
    let originating = resolution.identity.as_ref().map(|identity| identity.stamp_header(&mut header_opts));
    let source_header = crate::source_header::parse_source_header(source);
    crate::step_header::write_header_originating(&mut out, &header_opts, source_header.as_ref(), schema, originating.as_deref())?;

    let Resolution { appended, edits_by_id, removed, reasons, refusals, patched, added, patched_objects, dropped_representations, findings, .. } =
        resolution;
    let defined = DefinedIds::new(index, &removed, &appended);
    let mut validator = StreamValidator::new(schema);
    let mut type_upper = String::new();
    let mut attribute_edits_refused = 0usize;
    let mut unapplied: Vec<ValidationFinding> = Vec::new();
    let mut written = 0usize;

    for (id, type_name, start, end) in index.records() {
        if removed.contains(&id) {
            continue;
        }
        // An untouched record is the source's own bytes; an edited one keeps
        // every byte the edits leave alone (`source_text::apply_edits`).
        let bytes = &source[start..end];
        let edited: Option<Vec<u8>> = edits_by_id.get(&id).map(|edits| {
            let before = attribute_edits_refused;
            let edited = source_text::apply_edits(bytes, edits, &mut attribute_edits_refused);
            if attribute_edits_refused > before {
                unapplied.push(ValidationFinding {
                    express_id: Some(id),
                    message: format!("{} planned attribute edit(s) could not be applied", attribute_edits_refused - before),
                });
            }
            edited
        });
        let written_bytes = edited.as_deref().unwrap_or(bytes);
        out.write_all(written_bytes)?;
        let line = String::from_utf8_lossy(written_bytes);
        out.write_all(b"\n")?;
        written += 1;
        type_upper.clear();
        type_upper.push_str(type_name);
        type_upper.make_ascii_uppercase();
        validator.record(id, &type_upper, &line, |r| defined.contains(r));
    }
    for (id, text) in &appended {
        out.write_all(text.as_bytes())?;
        out.write_all(b"\n")?;
        written += 1;
        validator.record(*id, &appended_type(text), text, |r| defined.contains(r));
    }
    out.write_all(b"ENDSEC;\nEND-ISO-10303-21;\n")?;
    out.flush()?;

    let mut psets = duplicate_sets_on_patched(index, schema, &appended, &edits_by_id, &removed, &patched_objects);
    psets.extend(unapplied);
    psets.extend(findings);
    let mut duplicates: Vec<u32> = index.duplicates.iter().copied().collect();
    duplicates.sort_unstable();
    psets.extend(duplicates.into_iter().map(|id| ValidationFinding {
        express_id: Some(id),
        message: crate::step_index::RecordIndex::duplicate_warning(id),
    }));

    Ok(WriteReport {
        total: index.len(),
        written,
        deleted: removed.len(),
        removed: removals(&removed, &reasons),
        patched,
        added,
        refusals,
        findings: validator.finish(psets),
        dropped_representations,
    })
}

/// The duplicate-set check over the objects the plan patched, reading each
/// relationship and set as it was written.
fn duplicate_sets_on_patched(
    index: &FileIndex,
    schema: &str,
    appended: &[(u32, String)],
    edits_by_id: &HashMap<u32, BTreeMap<usize, String>>,
    removed: &HashSet<u32>,
    patched_objects: &[u32],
) -> Vec<ValidationFinding> {
    let appended_by_id: FxHashMap<u32, &str> = appended.iter().map(|(id, text)| (*id, text.as_str())).collect();
    let final_record = |id: u32| -> Option<(String, String)> {
        if let Some(text) = appended_by_id.get(&id) {
            return Some((appended_type(text), (*text).to_string()));
        }
        if removed.contains(&id) {
            return None;
        }
        // The record as written: the source bytes with the plan's edits.
        let bytes = index.record_bytes(id)?;
        let text = match edits_by_id.get(&id) {
            Some(edits) => String::from_utf8_lossy(&source_text::apply_edits(bytes, edits, &mut 0)).into_owned(),
            None => String::from_utf8_lossy(bytes).into_owned(),
        };
        Some((index.type_of(id)?, text))
    };
    let scope: FxHashSet<u32> = patched_objects.iter().copied().collect();
    let mut rel_ids: Vec<u32> = patched_objects
        .iter()
        .flat_map(|&object| index.referrers(object).iter().map(|&(rel, _)| rel))
        .filter(|rel| !removed.contains(rel) && index.type_of(*rel).as_deref() == Some("IFCRELDEFINESBYPROPERTIES"))
        .chain(appended.iter().filter(|(_, text)| appended_type(text) == "IFCRELDEFINESBYPROPERTIES").map(|(id, _)| *id))
        .collect();
    rel_ids.sort_unstable();
    rel_ids.dedup();
    let rels: Vec<String> = rel_ids.into_iter().filter_map(|rel| final_record(rel).map(|(_, text)| text)).collect();
    duplicate_pset_names(schema, rels, final_record, |object| scope.contains(&object))
}

/// UPPERCASE type of a record this executor synthesized.
fn appended_type(text: &str) -> String {
    ifc_lite_core::parser::StepRecord::parse(text.as_bytes())
        .and_then(|record| record.keyword())
        .map(str::to_ascii_uppercase)
        .unwrap_or_default()
}

/// Every id declared in the output: the source's, less what was removed,
/// plus what was appended. A bitset over the id range when ids are dense
/// enough for that to be small; otherwise the source index answers directly.
struct DefinedIds<'i, 'a> {
    bits: Option<Vec<u64>>,
    index: &'i FileIndex<'a>,
    removed: &'i HashSet<u32>,
    appended: FxHashSet<u32>,
}

impl<'i, 'a> DefinedIds<'i, 'a> {
    fn new(index: &'i FileIndex<'a>, removed: &'i HashSet<u32>, appended: &[(u32, String)]) -> Self {
        let top = appended.iter().map(|&(id, _)| id).fold(index.max_id, u32::max) as u64;
        let dense = top <= 64 * index.len() as u64 + (1 << 20);
        let bits = dense.then(|| {
            let mut bits = vec![0u64; (top / 64 + 1) as usize];
            index.for_each_id(|id| bits[id as usize / 64] |= 1 << (id % 64));
            for &id in removed {
                if let Some(word) = bits.get_mut(id as usize / 64) {
                    *word &= !(1 << (id % 64));
                }
            }
            for &(id, _) in appended {
                bits[id as usize / 64] |= 1 << (id % 64);
            }
            bits
        });
        let appended = if bits.is_some() { FxHashSet::default() } else { appended.iter().map(|&(id, _)| id).collect() };
        Self { bits, index, removed, appended }
    }

    fn contains(&self, id: u32) -> bool {
        match &self.bits {
            Some(bits) => bits.get(id as usize / 64).is_some_and(|w| w & (1 << (id % 64)) != 0),
            None => (self.index.contains(id) && !self.removed.contains(&id)) || self.appended.contains(&id),
        }
    }
}

/// Every removed record and why, by id: the reason the resolution recorded,
/// or replaced for what a patch removed itself (an old placement chain or
/// body).
fn removals(removed: &HashSet<u32>, reasons: &HashMap<u32, RemovalReason>) -> Vec<Removal> {
    let mut out: Vec<Removal> =
        removed.iter().map(|&id| Removal::new(id, reasons.get(&id).copied().unwrap_or(RemovalReason::Replaced))).collect();
    out.sort_unstable_by_key(|r| r.express_id);
    out
}
