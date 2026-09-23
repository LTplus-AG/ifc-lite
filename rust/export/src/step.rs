// SPDX-License-Identifier: MPL-2.0
//! **STEP / IFC** (ISO-10303-21) exporter — re-serialize the parsed model back to a
//! valid `.ifc` text.
//!
//! Phase 2 **P1**: faithful base re-serialization (original entity lines, regenerated
//! header) + subset export via a forward-`#`-reference closure (so a filtered export
//! never dangles a reference). Entity-type **schema conversion** (IFC2X3↔4↔4X3) and
//! **mutation application** (MutablePropertyView edits bridged from TS) are the P2/P3
//! follow-ons; the structure here is the seam they plug into.

use std::collections::{BTreeMap, HashMap, HashSet};

use ifc_lite_core::EntityScanner;

pub use crate::step_api::{
    AttrMutation, CopyOnWriteMutation, PropMutation, StepOptions, StepStats,
};

use crate::schema_detect::detect_schema;
use crate::step_text::{
    apply_attr_mutations_counted, escape, merge_edits, refs_in_line_counted, renumber,
};

/// Export the parsed model in `content` as a STEP/IFC string.
///
/// Errs when a source entity's (possibly renamed) type has no representation
/// at all in an explicit `opts.schema` target and is not an `IfcRoot`
/// subtype either — see [`crate::schema_unrepresented`] (#5116).
pub fn export_step(content: &[u8], opts: &StepOptions) -> std::io::Result<String> {
    export_step_with_stats(content, opts).map(|(s, _)| s)
}

/// Like [`export_step`] but also returns coverage stats.
pub fn export_step_with_stats(content: &[u8], opts: &StepOptions) -> std::io::Result<(String, StepStats)> {
    // Presized for a full re-export, where the output is within a small factor
    // of the source. Not for a subset: 200 MB filtered to a few records would
    // reserve 200 MB, and on wasm that linear memory never comes back.
    let mut buf = match opts.included {
        None => Vec::with_capacity(content.len()),
        Some(_) => Vec::new(),
    };
    // `emit`, not `export_step_to_writer`: a `Vec` needs no buffering, and
    // wrapping one memcpys the whole output through a 1 MiB window for nothing.
    // A Vec's `Write` impl cannot fail for I/O reasons, so an `Err` here is
    // always a schema-conversion failure (`emit` also propagates those through
    // this same `io::Result`, see `schema_unrepresented::UnrepresentedEntityError`'s
    // `From` impl) — genuinely fallible now, unlike the `.expect` this replaced.
    let stats = emit(content, opts, &mut buf)?;
    // Every byte came from the source by way of `from_utf8_lossy`, or from a
    // `format!`, so this validates rather than converts.
    let out = String::from_utf8(buf).expect("the writer emits UTF-8");
    Ok((out, stats))
}

/// [`export_step_with_stats`], writing as it goes instead of returning the file.
/// The two cannot drift: that one is this one writing into a `Vec`.
///
/// The gigabyte of `String` that doubled its way there is gone. What replaces
/// it is not free: the entity index measures ~84 bytes a record, so 370 MB on
/// 4.4 M records and ~1.1 GB on 16.8 M, before a byte is written. On a very
/// large model it outweighs the output it stopped holding, and it is not
/// removable -- source order and the reference closure both need it.
///
/// `out` is buffered here, so a bare `File` is fine. A record costs two `write`
/// calls, which unbuffered is two syscalls: measured 15.0 s against 4.3 s on
/// 4.4 M records. A caller who already buffers pays one memcpy through 1 MiB.
// The grouped-property-mutation Vec type is explicit by design; aliasing it
// would hide the (entity, pset) -> [(key, value)] grouping structure.
#[allow(clippy::type_complexity)]
pub fn export_step_to_writer<W: std::io::Write>(
    content: &[u8],
    opts: &StepOptions,
    w: &mut W,
) -> std::io::Result<StepStats> {
    use std::io::Write as _;
    let mut buffered = std::io::BufWriter::with_capacity(1 << 20, w);
    let stats = emit(content, opts, &mut buffered)?;
    // Flushed here for the error, not for the bytes: `BufWriter::drop` does
    // flush, it just has nowhere to report a failure and swallows it.
    buffered.flush()?;
    Ok(stats)
}

/// Write one record this exporter SYNTHESIZES (a property set, its properties,
/// the relationship that attaches it), through the IFC2X3 required-slot fills
/// when the output is IFC2X3, or the IFC4 ones (#5307) when the output is an
/// IFC4X3/IFC5 -> IFC4 downgrade.
///
/// These records never reach `convert_step_line` — they are built here, after
/// the emit loop — so before #4714 they went out with `$` in `OwnerHistory`,
/// which IFC2X3 requires, even when the file had an owner history to point
/// them at. Source records are filled inside the converter; these are filled
/// here, through the same objects, so both land in the same counters. None of
/// `IFCPROPERTYSINGLEVALUE`/`IFCPROPERTYSET`/`IFCRELDEFINESBYPROPERTIES`'s own
/// IFC4-required slots (`Name`, `GlobalId`, `HasProperties`,
/// `RelatedObjects`, `RelatingPropertyDefinition`) can hold `$` in a line this
/// function writes — every one is always given a real value — so this is
/// parity with the IFC2X3 path rather than a fill that ever fires today.
fn write_synthesized<W: std::io::Write>(
    out: &mut W,
    line: String,
    targets_ifc2x3: bool,
    slot_fill: &mut crate::schema_ifc2x3_slots::Ifc2x3SlotFill,
    targets_ifc4_downgrade: bool,
    ifc4_slot_fill: &mut crate::schema_ifc4_slots::Ifc4SlotFill,
) -> std::io::Result<()> {
    let line = if targets_ifc2x3 {
        slot_fill.apply(line)
    } else if targets_ifc4_downgrade {
        ifc4_slot_fill.apply(line)
    } else {
        line
    };
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")
}

#[allow(clippy::type_complexity)]
fn emit<W: std::io::Write>(
    content: &[u8],
    opts: &StepOptions,
    out: &mut W,
) -> std::io::Result<StepStats> {
    // 1. Index every entity line (preserve source order).
    let mut order: Vec<u32> = Vec::new();
    let mut line_of: HashMap<u32, (usize, usize)> = HashMap::new();
    let mut max_id = 0u32;
    let mut owner_histories: Vec<u32> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        max_id = max_id.max(id);
        if type_name.eq_ignore_ascii_case("IFCOWNERHISTORY") {
            owner_histories.push(id);
        }
        if line_of.insert(id, (start, end)).is_none() {
            order.push(id);
        }
    }

    // 2. Resolve the included set + forward reference closure.
    let mut refused_refs = 0usize;
    let mut attribute_edits_refused = 0usize;
    let included: HashSet<u32> = match &opts.included {
        None => order.iter().copied().collect(),
        Some(roots) => {
            let mut keep: HashSet<u32> = HashSet::new();
            let mut stack: Vec<u32> = roots.clone();
            let mut refs = Vec::new();
            while let Some(id) = stack.pop() {
                if !keep.insert(id) {
                    continue;
                }
                if let Some(&(s, e)) = line_of.get(&id) {
                    refs.clear();
                    refs_in_line_counted(&content[s..e], &mut refs, &mut refused_refs);
                    for &r in &refs {
                        if !keep.contains(&r) {
                            stack.push(r);
                        }
                    }
                }
            }
            keep
        }
    };

    // Read the source HEADER once, here, so the writer can carry its
    // provenance forward instead of blanking it (see `step_header`).
    let source_header = crate::source_header::parse_source_header(content);
    let source_schema = detect_schema(content);
    let schema = opts.schema.clone().unwrap_or_else(|| source_schema.clone());
    // Only convert entity types/attributes when an explicit target differs from source.
    let converting = opts.schema.is_some()
        && crate::schema_convert::needs_conversion(&source_schema, &schema);
    // The slots IFC2X3 requires a value in: `OwnerHistory` from the first owner
    // history this export writes (#4686), the rest from the generated
    // required-slot table (#4714).
    let mut slot_fill = crate::schema_ifc2x3_slots::Ifc2x3SlotFill::new(
        owner_histories.into_iter().find(|id| included.contains(id)),
    );
    // The slots IFC4 requires a value in on a downgrade from IFC4X3/IFC5
    // (#5307, the Rust twin of #5202).
    let mut ifc4_slot_fill = crate::schema_ifc4_slots::Ifc4SlotFill::new();
    // The synthesized property sets below are filled whenever the OUTPUT is
    // IFC2X3, not only when a conversion runs: an IFC2X3 source needs no
    // conversion, and the records this exporter writes for it still have to be
    // valid IFC2X3.
    let targets_ifc2x3 = crate::schema_convert::targets_ifc2x3(&schema);
    // Same reasoning, for the IFC4X3/IFC5 -> IFC4 downgrade (#5307).
    let targets_ifc4_downgrade = crate::schema_convert::targets_ifc4_downgrade(&source_schema, &schema);

    // Root-attribute edits, resolved per (entity, attribute) as they are read.
    // A list plus a last-wins rule made "the value at this index" a derived
    // fact that every reader re-derived its own way, and two of them got it
    // wrong. Keyed by index there is nothing left to derive.
    let mut muts_by_id: HashMap<u32, BTreeMap<usize, String>> = HashMap::new();
    for m in &opts.attribute_mutations {
        muts_by_id.entry(m.express_id).or_default().insert(m.index, m.value.clone());
    }

    // Copy-on-write, resolved before the emit loop so the copies and the
    // repointed referrers both go through it. Its own module: the pass has four
    // rules now and every one of them is a file that came out wrong without it.
    let resolved = crate::step_cow::resolve(
        &opts.copy_on_write,
        content,
        &line_of,
        &included,
        &muts_by_id,
        max_id.checked_add(1),
    );
    let next_id = resolved.next_id;
    let copies_refused = resolved.refused;
    let copies = resolved.copies;
    let repointed = resolved.repointed;

    // 3. Emit header + filtered entities (source order) + footer.
    crate::step_header::write_header(out, opts, source_header.as_ref(), &schema)?;

    let mut written = 0usize;
    for id in &order {
        if included.contains(id) {
            if let Some(&(s, e)) = line_of.get(id) {
                let raw = String::from_utf8_lossy(&content[s..e]);
                // Apply root-attribute edits first (original-schema positions), then convert.
                let edited = match merge_edits(muts_by_id.get(id), repointed.get(id)) {
                    Some(edits) => {
                        apply_attr_mutations_counted(&raw, &edits, &mut attribute_edits_refused)
                    }
                    None => raw.into_owned(),
                };
                if converting {
                    let converted = crate::schema_convert::convert_step_line(
                        &edited,
                        &source_schema,
                        &schema,
                        *id,
                        &mut slot_fill,
                        Some(&mut ifc4_slot_fill),
                    )?;
                    out.write_all(converted.as_bytes())?;
                } else {
                    out.write_all(edited.as_bytes())?;
                }
                out.write_all(b"\n")?;
                written += 1;
            }
        }
    }

    // The copies, emitted rather than appended: counted in `written` and put
    // through `convert_step_line` like every other record.
    for (copy_id, source_id, edits) in &copies {
        if let Some(&(s0, e0)) = line_of.get(source_id) {
            let raw = String::from_utf8_lossy(&content[s0..e0]);
            // The caller's edits to the record belong to the copy too: the
            // copy is this element's version of that record, not a snapshot
            // taken before the caller touched it. Repointings do not, which is
            // why they are resolved into their own map.
            let mut muts = muts_by_id.get(source_id).cloned().unwrap_or_default();
            muts.extend(edits.iter().map(|(i, v)| (*i, v.clone())));
            let edited = apply_attr_mutations_counted(&raw, &muts, &mut attribute_edits_refused);
            let renumbered = renumber(&edited, *copy_id);
            if converting {
                let converted = crate::schema_convert::convert_step_line(
                    &renumbered,
                    &source_schema,
                    &schema,
                    *copy_id,
                    &mut slot_fill,
                    Some(&mut ifc4_slot_fill),
                )?;
                out.write_all(converted.as_bytes())?;
            } else {
                out.write_all(renumbered.as_bytes())?;
            }
            out.write_all(b"\n")?;
            written += 1;
        }
    }

    // 4. Synthesize new property sets from property mutations (fresh ids past max_id).
    if !opts.property_mutations.is_empty() {
        // Group props by (entity, pset) preserving first-seen order.
        let mut groups: Vec<((u32, String), Vec<(&str, &str)>)> = Vec::new();
        let mut index_of: HashMap<(u32, String), usize> = HashMap::new();
        for m in &opts.property_mutations {
            // Only attach to entities actually present in the export.
            if !included.contains(&m.express_id) {
                continue;
            }
            let key = (m.express_id, m.pset_name.clone());
            let idx = *index_of.entry(key.clone()).or_insert_with(|| {
                groups.push((key.clone(), Vec::new()));
                groups.len() - 1
            });
            groups[idx].1.push((m.prop_name.as_str(), m.value.as_str()));
        }

        // Same exhaustion, same answer: inventing ids on a full file would
        // duplicate real records.
        let Some(mut next) = next_id else {
            out.write_all(b"ENDSEC;\nEND-ISO-10303-21;\n")?;
            return Ok(StepStats {
                total: order.len(),
                written,
                copies_refused,
                refused_refs,
                attribute_edits_refused,
                owner_history_unfilled: slot_fill.owner_history_unfilled(),
                required_slots_unfilled: slot_fill.required_slots_unfilled(),
                ifc4_required_slots_unfilled: ifc4_slot_fill.required_slots_unfilled(),
            });
        };
        for ((express_id, pset_name), props) in &groups {
            // One property set costs one id per property plus one for the set
            // and one for the relationship. Checking that a single id is left
            // is not enough: a group that starts near the ceiling used to run
            // off it part way through and wrap, emitting ids that already
            // belong to real records. A group that does not fit is skipped
            // whole, so nothing half-written reaches the file.
            let needed = u32::try_from(props.len()).ok().and_then(|n| n.checked_add(2));
            match needed.and_then(|n| u32::MAX.checked_sub(n).map(|limit| next <= limit)) {
                Some(true) => {}
                _ => continue,
            }
            let mut prop_refs: Vec<u32> = Vec::with_capacity(props.len());
            for (pname, value) in props {
                let line = format!(
                    "#{next}=IFCPROPERTYSINGLEVALUE('{}',$,{},$);",
                    escape(pname),
                    value
                );
                write_synthesized(out, line, targets_ifc2x3, &mut slot_fill, targets_ifc4_downgrade, &mut ifc4_slot_fill)?;
                prop_refs.push(next);
                next += 1;
                written += 1;
            }
            let psid = next;
            next += 1;
            let refs_str = prop_refs.iter().map(|r| format!("#{r}")).collect::<Vec<_>>().join(",");
            let line = format!(
                "#{psid}=IFCPROPERTYSET('{}',$,'{}',$,({}));",
                crate::schema_convert::placeholder_guid(psid),
                escape(pset_name),
                refs_str
            );
            write_synthesized(out, line, targets_ifc2x3, &mut slot_fill, targets_ifc4_downgrade, &mut ifc4_slot_fill)?;
            written += 1;
            let rid = next;
            next += 1;
            let line = format!(
                "#{rid}=IFCRELDEFINESBYPROPERTIES('{}',$,$,$,(#{express_id}),#{psid});",
                crate::schema_convert::placeholder_guid(rid),
            );
            write_synthesized(out, line, targets_ifc2x3, &mut slot_fill, targets_ifc4_downgrade, &mut ifc4_slot_fill)?;
            written += 1;
        }
    }

    out.write_all(b"ENDSEC;\nEND-ISO-10303-21;\n")?;

    Ok(StepStats {
        total: order.len(),
        written,
        copies_refused,
        refused_refs,
        attribute_edits_refused,
        owner_history_unfilled: slot_fill.owner_history_unfilled(),
        required_slots_unfilled: slot_fill.required_slots_unfilled(),
        ifc4_required_slots_unfilled: ifc4_slot_fill.required_slots_unfilled(),
    })
}

#[cfg(test)]
#[path = "step_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "step_roundtrip_tests.rs"]
mod roundtrip_tests;
