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
pub fn export_step(content: &[u8], opts: &StepOptions) -> String {
    export_step_with_stats(content, opts).0
}

/// Like [`export_step`] but also returns coverage stats.
pub fn export_step_with_stats(content: &[u8], opts: &StepOptions) -> (String, StepStats) {
    // Presized for a full re-export, where the output is within a small factor
    // of the source. Not for a subset: 200 MB filtered to a few records would
    // reserve 200 MB, and on wasm that linear memory never comes back.
    let mut buf = match opts.included {
        None => Vec::with_capacity(content.len()),
        Some(_) => Vec::new(),
    };
    // `emit`, not `export_step_to_writer`: a `Vec` needs no buffering, and
    // wrapping one memcpys the whole output through a 1 MiB window for nothing.
    let stats = emit(content, opts, &mut buf).expect("a Vec accepts every write");
    // Every byte came from the source by way of `from_utf8_lossy`, or from a
    // `format!`, so this validates rather than converts.
    let out = String::from_utf8(buf).expect("the writer emits UTF-8");
    (out, stats)
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
    let mut scanner = EntityScanner::new(content);
    while let Some((id, _type, start, end)) = scanner.next_entity() {
        max_id = max_id.max(id);
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
                    out.write_all(
                        crate::schema_convert::convert_step_line(
                            &edited,
                            &source_schema,
                            &schema,
                            *id,
                        )
                        .as_bytes(),
                    )?;
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
                out.write_all(
                    crate::schema_convert::convert_step_line(
                        &renumbered,
                        &source_schema,
                        &schema,
                        *copy_id,
                    )
                    .as_bytes(),
                )?;
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
                writeln!(
                    out,
                    "#{next}=IFCPROPERTYSINGLEVALUE('{}',$,{},$);",
                    escape(pname),
                    value
                )?;
                prop_refs.push(next);
                next += 1;
                written += 1;
            }
            let psid = next;
            next += 1;
            let refs_str = prop_refs.iter().map(|r| format!("#{r}")).collect::<Vec<_>>().join(",");
            writeln!(
                out,
                "#{psid}=IFCPROPERTYSET('{}',$,'{}',$,({}));",
                crate::schema_convert::placeholder_guid(psid),
                escape(pset_name),
                refs_str
            )?;
            written += 1;
            let rid = next;
            next += 1;
            writeln!(
                out,
                "#{rid}=IFCRELDEFINESBYPROPERTIES('{}',$,$,$,(#{express_id}),#{psid});",
                crate::schema_convert::placeholder_guid(rid),
            )?;
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
    })
}

#[cfg(test)]
#[path = "step_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "step_roundtrip_tests.rs"]
mod roundtrip_tests;
