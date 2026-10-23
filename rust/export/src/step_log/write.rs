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
use super::created::write_created;
use super::ledger::Kind;
use super::refilter::{filter_source_line, Filtered};
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
    /// Non-`$` attribute values a conversion had no target slot for (#7683).
    pub attribute_values_dropped: usize,
    /// Source records dropped because a later record has their express id
    /// (#7682); each is also named in the warnings.
    pub duplicate_records_dropped: usize,
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
            attribute_values_dropped: s.step.attribute_values_dropped,
            // The log path takes no `PropMutation`s (they are refused up front).
            property_mutations_refused: 0,
            duplicate_records_dropped: s.step.duplicate_records_dropped,
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

/// One record out, through the schema converter when the export converts.
#[allow(clippy::too_many_arguments)]
fn write_line<W: Write>(
    out: &mut W,
    text: &str,
    id: u32,
    converting: bool,
    from: &str,
    to: &str,
    slot_fill: &mut crate::schema_ifc2x3_slots::Ifc2x3SlotFill,
    checks: &mut crate::schema_enum::ConversionChecks,
    flatten: &crate::schema_style_flatten::StyleFlatten,
) -> io::Result<bool> {
    if converting {
        let Some(flat) = flatten.line(from, text.to_string()) else { return Ok(false) };
        let text = flat.as_str();
        let converted = crate::schema_convert::convert_step_line(text, from, to, id, slot_fill, Some(checks))?;
        out.write_all(converted.as_bytes())?;
    } else {
        out.write_all(text.as_bytes())?;
    }
    out.write_all(b"\n").map(|()| true)
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
    // A created entity never reuses a source id (the mutation layer's
    // watermark allocates past the file's highest one), so a log that creates
    // one under a source id, even one it deletes again, was written against
    // another file. Writing either record would silently drop the other, and
    // a later delete of the created one would tombstone the source record
    // (#7682, EXPORT-STEP-26). The TypeScript writer throws the same text.
    let created = log.new_entities.iter().map(|e| e.express_id).chain(
        log.mutations.iter().filter(|m| m.kind == super::wire::MutationKind::CreateEntity).map(|m| m.entity_id),
    );
    if let Some(id) = created.into_iter().find(|&id| src.has(id)) {
        return Err(invalid(format!(
            "export_step_with_log: created entity #{id} reuses source id #{id}: the log was not written against this file"
        )));
    }
    let family = schema_family(content);
    let source_label = detect_schema(content);
    let target = opts.schema.clone().unwrap_or_else(|| source_label.clone());
    let converting = opts.schema.is_some() && crate::schema_convert::needs_conversion(&source_label, &target);

    let target_is_ifc2x3 = crate::schema_convert::targets_ifc2x3(&target);
    if target_is_ifc2x3 && log.georef_mutations.as_ref().is_some_and(super::georef::requests_anything) {
        return Err(invalid(format!("export_step_with_log: {}", super::georef::IFC2X3_REFUSAL)));
    }
    let wanted = touched(log);
    let mut base = BaseSets::new(&src, &wanted);
    let overlay = replay(&log.mutations, &log.new_entities, &mut base)
        .map_err(|e| invalid(format!("export_step_with_log: {}", e.0)))?;
    let mut pass = Pass::new(&src, family, overlay);
    pass.warnings.extend(src.duplicates.iter().map(|&id| crate::step_index::RecordIndex::duplicate_warning(id)));
    let unwritable = |e: super::values::Unwritable| invalid(format!("export_step_with_log: {}", e.0));
    let collected = collect(&mut pass, &mut base);
    if let Some(georef) = &log.georef_mutations {
        super::georef::apply(&mut pass, georef).map_err(unwritable)?;
    }
    retain_shared_atoms(&mut pass);

    // The source lines the log rewrites, decided before the header because
    // the header counts them: every record with an attribute, retype or
    // positional edit, run through the same filter the stream applies so a
    // withheld line nominates nothing, as in the TypeScript source pass.
    let mut edited: Vec<u32> = pass.modified_attributes.iter().map(|(id, _)| *id).collect();
    edited.extend(pass.overlay.positional.keys().copied());
    edited.extend(pass.overlay.retype_order.iter().copied());
    edited.sort_unstable();
    edited.dedup();
    for id in edited {
        if pass.skip.contains(&id) || pass.rewritten.contains(&id) || pass.is_deleted(id) || pass.is_overlay_created(id) {
            continue;
        }
        let Some(line) = src.line(id).map(|l| l.into_owned()) else { continue };
        let (text, delivery) = pass.mutate_line(id, &line).map_err(unwritable)?;
        // Copy-on-write narrowing before the omitted-reference filter, as the
        // source pass orders them (#5794). A narrowed-to-nobody line is
        // withheld silently; `settle` rules that out for the effective record.
        let Some(text) = super::cow::detach(&pass, id, text) else {
            pass.skip.insert(id);
            continue;
        };
        let upper = pass.type_of(id).unwrap_or_default();
        let filtered = {
            let excluded = |r: u32| pass.is_omitted(r);
            filter_source_line(&text, id, &upper, pass.schema, &excluded, !pass.overlay.tombstones.is_empty())
        };
        let text = match filtered {
            Filtered::Keep => Some(text),
            Filtered::Rewrite(t) => Some(t),
            Filtered::Withhold(_) => None,
        };
        if text.is_some() {
            if delivery.retyped {
                pass.ledger.nominate(id, Kind::Retype);
            }
            if delivery.positional {
                pass.ledger.nominate(id, Kind::Positional);
            }
            pass.nominees.nominate_delivered(&mut pass.ledger, id, &delivery);
        }
        pass.mutated_lines.insert(id, (text, delivery));
    }
    generate(&mut pass, collected).map_err(unwritable)?;
    write_created(&mut pass).map_err(unwritable)?;

    let modifications = pass.new_entity_count + pass.ledger.modified_count();
    let source_header = crate::source_header::parse_source_header(content);
    let header_schema = crate::file_schema::declared_token(source_header.as_ref(), converting, &target);
    crate::step_header::write_header_counted(out, opts, source_header.as_ref(), header_schema, modifications)?;

    let mut slot_fill = crate::schema_ifc2x3_slots::Ifc2x3SlotFill::new(pass.fallback_owner_history());
    let mut checks = crate::schema_enum::ConversionChecks::new();
    let mut flatten = crate::schema_style_flatten::StyleFlatten::for_export(content, &source_label, &target); flatten.note_all(content, pass.mutated_lines.iter().filter_map(|(id, (t, _))| Some((*id, t.as_deref()?)))
        .chain(pass.generated.iter().chain(&pass.rewritten_lines).chain(&pass.georef_lines).chain(&pass.created_lines).map(|(id, l)| (*id, l.as_str()))));
    let mut written = 0usize;
    for &id in &src.order {
        if pass.skip.contains(&id) || pass.rewritten.contains(&id) || pass.is_deleted(id) || flatten.drops(id) {
            continue;
        }
        let owned;
        let text: &str = match pass.mutated_lines.get(&id) {
            Some((Some(text), _)) => text,
            Some((None, _)) => {
                let upper = pass.type_of(id).unwrap_or_default();
                pass.warnings.push(format!("Relationship #{id} ({upper}) was withheld from the export: it names at least one entity that has no line in this export, in a slot with no spelling for an omitted reference (a single-valued attribute, or a set whose every member is omitted). Anything else that relationship associated is no longer associated in the output."));
                continue;
            }
            None => {
                let Some(raw) = src.line(id) else { continue };
                let raw = match super::cow::detach(&pass, id, raw.into_owned()) {
                    Some(line) => line,
                    None => continue,
                };
                let upper = pass.type_of(id).unwrap_or_default();
                let filtered = {
                    let excluded = |r: u32| pass.is_omitted(r);
                    filter_source_line(&raw, id, &upper, pass.schema, &excluded, !pass.overlay.tombstones.is_empty())
                };
                owned = match filtered {
                    Filtered::Keep => raw,
                    Filtered::Rewrite(t) => t,
                    Filtered::Withhold(w) => {
                        pass.warnings.push(w);
                        continue;
                    }
                };
                &owned
            }
        };
        written += usize::from(write_line(out, text, id, converting, &source_label, &target, &mut slot_fill, &mut checks, &flatten)?);
    }
    // Every appended record goes out through the same `write_line` as a
    // source one, in the TypeScript exporter's order: generated sets, the
    // repointed type objects, the georeferencing records, the created
    // entities. Each is in the source schema's layout, so a converting export
    // converts it (renames, the quantity `Formula` slot, the IFC2X3 slot fill
    // and its counters) instead of writing it raw (#7682, EXPORT-STEP-3).
    let appended = pass
        .generated
        .iter()
        .chain(&pass.rewritten_lines)
        .chain(&pass.georef_lines)
        .chain(&pass.created_lines);
    for (id, line) in appended.filter(|(id, _)| !flatten.drops(*id)) {
        written += usize::from(write_line(out, line, *id, converting, &source_label, &target, &mut slot_fill, &mut checks, &flatten)?);
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
            attribute_values_dropped: checks.attribute_values_dropped,
            duplicate_records_dropped: src.duplicates.len(),
        },
    })
}
