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
use serde::Deserialize;

/// A single root-attribute edit: replace the top-level attribute at `index` of entity
/// `express_id` with `value` (already STEP-serialized, e.g. `'New Name'` or `$`).
/// This is the wasm-bridge form of a `MutablePropertyView` UPDATE_ATTRIBUTE mutation.
pub struct AttrMutation {
    pub express_id: u32,
    pub index: usize,
    pub value: String,
}

/// A property create/update: attach (or overwrite) `prop_name` in `pset_name` on
/// `express_id` with `value` — the STEP-serialized nominal value, e.g. `IFCLABEL('2HR')`
/// or `IFCREAL(42.)`. The wasm-bridge form of a `MutablePropertyView` CREATE/UPDATE_PROPERTY.
/// Synthesizes fresh `IfcPropertySingleValue` / `IfcPropertySet` / `IfcRelDefinesByProperties`
/// entities appended to DATA (new psets; merge-into-existing is a follow-on).
pub struct PropMutation {
    pub express_id: u32,
    pub pset_name: String,
    pub prop_name: String,
    pub value: String,
}

/// Replace one attribute of a record that other records share, by copying the
/// record and repointing a single referrer at the copy.
///
/// The reason this is a writer job rather than a caller one is the id. A copy
/// needs a number no record holds, and the writer is what knows `max_id`; a
/// caller that allocates its own has to agree with `PropMutation`'s synthesis
/// about which numbers are free, and two allocators sharing one space is a
/// collision waiting for the first export that uses both.
///
/// Doing it here also keeps the copy inside the emit path, so it is counted in
/// [`StepStats::written`] and converted when the export targets another schema.
/// A record spliced into the output afterwards is neither.
///
/// Property sets are the case this exists for. IFC exporters routinely give
/// each element its own `IfcPropertySet` and point them all at one
/// `IfcPropertySingleValue` per distinct value, so editing that value in place
/// changes it for every element sharing it. Copying first changes one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyOnWriteMutation {
    /// The record to copy.
    pub express_id: u32,
    /// Which attribute of the copy to replace, zero-based.
    pub index: usize,
    /// The replacement, STEP-serialized, e.g. `IFCLABEL('2HR')`.
    pub value: String,
    /// The record that should point at the copy instead of the original.
    pub referrer_id: u32,
    /// Which attribute of the referrer holds that reference. A list attribute
    /// is rewritten with the one reference substituted and the rest untouched.
    pub referrer_index: usize,
}

/// Options for STEP export.
pub struct StepOptions {
    /// FILE_SCHEMA label to write (e.g. `IFC4`). `None` ⇒ preserve the source schema.
    /// When `Some` and the target differs, entity types/attributes are converted (P2).
    pub schema: Option<String>,
    /// Express ids to include. `None` ⇒ the whole model. When set, the forward
    /// reference closure is added so every emitted `#ref` resolves.
    pub included: Option<Vec<u32>>,
    /// Root-attribute edits to apply during serialization (P3 mutation bridge).
    pub attribute_mutations: Vec<AttrMutation>,
    /// Property create/update edits — synthesized as new pset entities appended to DATA.
    pub property_mutations: Vec<PropMutation>,
    /// Copy-then-edit mutations for records other records share.
    pub copy_on_write: Vec<CopyOnWriteMutation>,
    pub description: String,
    pub author: String,
    pub organization: String,
    pub application: String,
}

impl Default for StepOptions {
    fn default() -> Self {
        Self {
            schema: None,
            included: None,
            attribute_mutations: Vec::new(),
            property_mutations: Vec::new(),
            copy_on_write: Vec::new(),
            description: "ViewDefinition [CoordinationView]".to_string(),
            author: "".to_string(),
            organization: "".to_string(),
            application: "ifc-lite".to_string(),
        }
    }
}

/// Coverage stats for a STEP export.
pub struct StepStats {
    /// Entities in the source model.
    pub total: usize,
    /// Entities written (after filtering + reference closure).
    pub written: usize,
    /// Copy-on-write mutations the file could not express, so none was made.
    /// Non-zero means an edit the caller asked for is not in the output, and
    /// the caller is the only one who can say what to do about it.
    pub copies_refused: usize,
}

use crate::step_text::{
    apply_attr_mutations, detect_schema, escape, merge_edits, refs_in_line, renumber,
};

// ── Mutation JSON bridge (the wasm-facing contract) ─────────────────────────

#[derive(Deserialize)]
struct AttrMutJson {
    #[serde(rename = "expressId")]
    express_id: u32,
    index: usize,
    value: String,
}

#[derive(Deserialize)]
struct PropMutJson {
    #[serde(rename = "expressId")]
    express_id: u32,
    #[serde(rename = "psetName")]
    pset_name: String,
    #[serde(rename = "propName")]
    prop_name: String,
    value: String,
}

#[derive(Deserialize, Default)]
struct MutationsJson {
    #[serde(default, rename = "attributeUpdates")]
    attribute_updates: Vec<AttrMutJson>,
    #[serde(default, rename = "propertyMutations")]
    property_mutations: Vec<PropMutJson>,
}

/// Export STEP from raw bytes + a JSON mutation payload (the wasm bridge form of a
/// `MutablePropertyView` diff). `mutations_json` shape:
/// `{ "attributeUpdates": [{expressId,index,value}], "propertyMutations":
/// [{expressId,psetName,propName,value}] }` where `value` is already STEP-serialized
/// (`'Name'`, `IFCLABEL('x')`, `IFCREAL(1.)`). An empty string means "no mutations" —
/// a legitimate, common case (plain re-export). A non-empty string that fails to
/// parse is a caller bug (a malformed payload, a version mismatch across the wasm
/// boundary) and must not be treated the same way: silently falling back to "no
/// mutations" would export a file that LOOKS like a successful re-export of the
/// user's edits but silently contains none of them. Callers get an `Err` instead,
/// matching `exportGlb`'s and `exportMerged`'s fail-closed contract at this same
/// wasm boundary.
pub fn export_step_json(
    content: &[u8],
    schema: Option<String>,
    included: Option<Vec<u32>>,
    mutations_json: &str,
) -> Result<String, String> {
    let muts: MutationsJson = if mutations_json.trim().is_empty() {
        MutationsJson::default()
    } else {
        serde_json::from_str(mutations_json)
            .map_err(|e| format!("invalid mutations_json: {e}"))?
    };
    let opts = StepOptions {
        schema,
        included,
        attribute_mutations: muts
            .attribute_updates
            .into_iter()
            .map(|a| AttrMutation { express_id: a.express_id, index: a.index, value: a.value })
            .collect(),
        property_mutations: muts
            .property_mutations
            .into_iter()
            .map(|p| PropMutation {
                express_id: p.express_id,
                pset_name: p.pset_name,
                prop_name: p.prop_name,
                value: p.value,
            })
            .collect(),
        ..StepOptions::default()
    };
    Ok(export_step(content, &opts))
}

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
                    refs_in_line(&content[s..e], &mut refs);
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
    crate::step_header::write_header(out, opts, &schema)?;

    let mut written = 0usize;
    for id in &order {
        if included.contains(id) {
            if let Some(&(s, e)) = line_of.get(id) {
                let raw = String::from_utf8_lossy(&content[s..e]);
                // Apply root-attribute edits first (original-schema positions), then convert.
                let edited = match merge_edits(muts_by_id.get(id), repointed.get(id)) {
                    Some(edits) => apply_attr_mutations(&raw, &edits),
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
            let edited = apply_attr_mutations(&raw, &muts);
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
            return Ok(StepStats { total: order.len(), written, copies_refused });
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

    Ok(StepStats { total: order.len(), written, copies_refused })
}

#[cfg(test)]
#[path = "step_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "step_roundtrip_tests.rs"]
mod roundtrip_tests;
