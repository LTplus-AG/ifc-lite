// SPDX-License-Identifier: MPL-2.0
//! The export itself: plan every change the log implies, write the header
//! with the count those changes add up to, then stream the source records
//! through and append what the log generated.
//!
//! Output order is the TypeScript `StepExporter`'s: source records in
//! express-id order (minus the ones withheld or moved), then the generated
//! property sets, the generated quantity sets, and last the type objects whose
//! `HasPropertySets` was repointed.

use std::collections::HashSet;
use std::io::{self, Write};

use crate::schema_detect::detect_schema;
use crate::step_api::{StepOptions, StepStats};

use super::attrs::schema_family;
use super::base::BaseSets;
use super::collect::{collect, retain_shared_atoms};
use super::generate::generate;
use super::lines::{filter_relationship, Filtered};
use super::replay::replay;
use super::pass::Pass;
use super::source::Source;
use super::wire::MutationLog;

/// What a mutation-log export reports beyond [`StepStats`].
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct LogExportStats {
    /// Records written, and the conversion counters, as the plain writer
    /// reports them. `attribute_edits_refused` counts named edits a REAL slot
    /// refused.
    pub written: usize,
    /// Records in the source.
    pub total: usize,
    /// Records the log added (`StepExportResult.stats.newEntityCount`).
    pub new_entities: usize,
    /// Source records the log changed, counted per entity
    /// (`modifiedEntityCount`).
    pub modified_entities: usize,
    /// Non-fatal refusals and withheld records, in the TypeScript exporter's
    /// wording where it has one.
    pub warnings: Vec<String>,
    /// The conversion and refusal counters of the plain writer.
    pub step: StepCounters,
}

/// [`StepStats`]' counters, carried over for a caller that reads them.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct StepCounters {
    pub attribute_edits_refused: usize,
    pub owner_history_unfilled: usize,
    pub required_slots_unfilled: usize,
    pub ifc4_required_slots_unfilled: usize,
    pub enum_values_lost: usize,
    pub enum_values_refused: usize,
}

impl From<&LogExportStats> for StepStats {
    fn from(s: &LogExportStats) -> Self {
        StepStats {
            total: s.total,
            written: s.written,
            copies_refused: 0,
            refused_refs: 0,
            attribute_edits_refused: s.step.attribute_edits_refused,
            owner_history_unfilled: s.step.owner_history_unfilled,
            required_slots_unfilled: s.step.required_slots_unfilled,
            ifc4_required_slots_unfilled: s.step.ifc4_required_slots_unfilled,
            enum_values_lost: s.step.enum_values_lost,
            enum_values_refused: s.step.enum_values_refused,
        }
    }
}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.into())
}

/// Export `content` with the edits in `log` applied, as a string.
///
/// Byte-identical to the TypeScript `StepExporter` given the same source and
/// the same log (`importMutations` into a view wired like the viewer's),
/// except the GlobalIds of records this export generates. Errs, writing
/// nothing, when the log carries a mutation kind this writer does not apply
/// yet, or when `opts` asks for something the log path does not combine with
/// (`included`, or the per-edit vectors of the plain writer).
pub fn export_step_with_log(
    content: &[u8],
    opts: &StepOptions,
    log: &MutationLog,
) -> io::Result<(String, LogExportStats)> {
    let mut buf = Vec::with_capacity(content.len());
    let stats = emit(content, opts, log, &mut buf)?;
    let out = String::from_utf8(buf).expect("the writer emits UTF-8");
    Ok((out, stats))
}

/// [`export_step_with_log`], writing as it goes. The source is read, never
/// copied: memory beyond the record index grows with the EDITS (the lines they
/// change, the records they generate), not with the file.
pub fn export_step_with_log_to_writer<W: Write>(
    content: &[u8],
    opts: &StepOptions,
    log: &MutationLog,
    w: &mut W,
) -> io::Result<LogExportStats> {
    let mut buffered = io::BufWriter::with_capacity(1 << 20, w);
    let stats = emit(content, opts, log, &mut buffered)?;
    buffered.flush()?;
    Ok(stats)
}

/// Every entity id the log names, the set the base-set maps are built for.
fn touched(log: &MutationLog) -> HashSet<u32> {
    log.mutations.iter().map(|m| m.entity_id).collect()
}

fn emit<W: Write>(content: &[u8], opts: &StepOptions, log: &MutationLog, out: &mut W) -> io::Result<LogExportStats> {
    if opts.included.is_some() {
        return Err(invalid("export_step_with_log: `included` is not supported with a mutation log"));
    }
    if !opts.attribute_mutations.is_empty() || !opts.property_mutations.is_empty() || !opts.copy_on_write.is_empty() {
        return Err(invalid(
            "export_step_with_log: pass edits in the log, not in StepOptions' attribute/property/copy-on-write vectors",
        ));
    }
    let src = Source::index(content);
    let family = schema_family(content);
    let source_label = detect_schema(content);
    let target = opts.schema.clone().unwrap_or_else(|| source_label.clone());
    let converting = opts.schema.is_some() && crate::schema_convert::needs_conversion(&source_label, &target);

    let wanted = touched(log);
    let mut base = BaseSets::new(&src, &wanted);
    let overlay = replay(&log.mutations, &mut base).map_err(|e| invalid(format!("export_step_with_log: {}", e.0)))?;
    let mut pass = Pass::new(&src, family, overlay);
    let collected = collect(&mut pass, &mut base);
    retain_shared_atoms(&mut pass);

    // The source lines the log rewrites, decided before the header because
    // the header counts them.
    let edited: Vec<u32> = pass.modified_attributes.iter().map(|(id, _)| *id).collect();
    for id in edited {
        if pass.skip.contains(&id) || pass.rewritten.contains(&id) {
            continue;
        }
        let Some(line) = src.line(id).map(|l| l.into_owned()) else { continue };
        let (text, delivery) = pass.mutate_line(id, &line);
        pass.nominees.nominate_delivered(&mut pass.ledger, id, &delivery);
        pass.mutated_lines.insert(id, (text, delivery));
    }
    generate(&mut pass, collected);

    let modifications = pass.new_entity_count + pass.ledger.modified_count();
    let source_header = crate::source_header::parse_source_header(content);
    let declared = source_header.as_ref().and_then(|h| h.schema_identifiers.first()).filter(|s| !s.is_empty());
    let header_schema = match declared {
        Some(token) if !converting => token.as_str(),
        _ => crate::file_schema::file_schema_identifier(&target),
    };
    crate::step_header::write_header_counted(out, opts, source_header.as_ref(), header_schema, modifications)?;

    let mut slot_fill = crate::schema_ifc2x3_slots::Ifc2x3SlotFill::new(pass.fallback_owner_history());
    let mut checks = crate::schema_enum::ConversionChecks::new();
    let mut written = 0usize;
    for &id in &src.order {
        if pass.skip.contains(&id) || pass.rewritten.contains(&id) {
            continue;
        }
        let Some(raw) = src.line(id) else { continue };
        let text = match pass.mutated_lines.get(&id) {
            Some((text, _)) => text.as_str(),
            None => raw.as_ref(),
        };
        let upper = src.type_of(id).unwrap_or_default();
        if let Filtered::Withhold(warning) = filter_relationship(text, id, &upper) {
            pass.warnings.push(warning);
            continue;
        }
        if converting {
            let converted =
                crate::schema_convert::convert_step_line(text, &source_label, &target, id, &mut slot_fill, Some(&mut checks))?;
            out.write_all(converted.as_bytes())?;
        } else {
            out.write_all(text.as_bytes())?;
        }
        out.write_all(b"\n")?;
        written += 1;
    }
    for line in pass.generated.iter().chain(pass.rewritten_lines.iter().map(|(_, l)| l)) {
        out.write_all(line.as_bytes())?;
        out.write_all(b"\n")?;
        written += 1;
    }
    out.write_all(b"ENDSEC;\nEND-ISO-10303-21;\n")?;

    let mut warnings = std::mem::take(&mut pass.warnings);
    warnings.extend(slot_fill.warnings());
    warnings.extend(checks.warnings());
    let refused = warnings.iter().filter(|w| w.contains("is not a number and the slot is REAL-typed")).count();
    Ok(LogExportStats {
        written,
        total: src.order.len(),
        new_entities: pass.new_entity_count,
        modified_entities: pass.ledger.modified_count(),
        warnings,
        step: StepCounters {
            attribute_edits_refused: refused,
            owner_history_unfilled: slot_fill.owner_history_unfilled(),
            required_slots_unfilled: slot_fill.required_slots_unfilled(),
            ifc4_required_slots_unfilled: checks.ifc4_slots.required_slots_unfilled(),
            enum_values_lost: checks.enums.lost(),
            enum_values_refused: checks.enums.refused(),
        },
    })
}
