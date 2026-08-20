// SPDX-License-Identifier: MPL-2.0
//! **STEP / IFC** (ISO-10303-21) exporter — re-serialize the parsed model back to a
//! valid `.ifc` text.
//!
//! Phase 2 **P1**: faithful base re-serialization (original entity lines, regenerated
//! header) + subset export via a forward-`#`-reference closure (so a filtered export
//! never dangles a reference). Entity-type **schema conversion** (IFC2X3↔4↔4X3) and
//! **mutation application** (MutablePropertyView edits bridged from TS) are the P2/P3
//! follow-ons; the structure here is the seam they plug into.

use std::collections::{HashMap, HashSet};

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
}

use crate::step_text::{
    apply_attr_mutations, attribute_of, detect_schema, escape, refs_in_line, renumber,
    substitute_ref_in_attr,
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
/// (`'Name'`, `IFCLABEL('x')`, `IFCREAL(1.)`). Empty/invalid JSON ⇒ no mutations.
pub fn export_step_json(
    content: &[u8],
    schema: Option<String>,
    included: Option<Vec<u32>>,
    mutations_json: &str,
) -> String {
    let muts: MutationsJson = if mutations_json.trim().is_empty() {
        MutationsJson::default()
    } else {
        serde_json::from_str(mutations_json).unwrap_or_default()
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
    export_step(content, &opts)
}

/// Export the parsed model in `content` as a STEP/IFC string.
pub fn export_step(content: &[u8], opts: &StepOptions) -> String {
    export_step_with_stats(content, opts).0
}

/// Like [`export_step`] but also returns coverage stats.
// The grouped-property-mutation Vec type is explicit by design; aliasing it
// would hide the (entity, pset) -> [(key, value)] grouping structure.
#[allow(clippy::type_complexity)]
pub fn export_step_with_stats(content: &[u8], opts: &StepOptions) -> (String, StepStats) {
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

    // Root-attribute edits, grouped by entity id.
    let mut muts_by_id: HashMap<u32, Vec<(usize, String)>> = HashMap::new();
    for m in &opts.attribute_mutations {
        muts_by_id.entry(m.express_id).or_default().push((m.index, m.value.clone()));
    }

    // Copy-on-write, resolved before the emit loop so the copies and the
    // repointed referrers both go through it.
    //
    // Allocated from a counter `PropMutation` synthesis continues from, so the
    // two cannot hand out the same id.
    //
    // `checked_add`, and `None` means no record can be added at all. Saturating
    // was worse than the overflow it replaced: on a file holding `u32::MAX` it
    // leaves the counter equal to an id the file already uses, so the first
    // copy silently collides with a real record. A file that has spent the
    // whole id space has no room for another record, and emitting one anyway
    // corrupts it, so none is emitted.
    let mut next_id = max_id.checked_add(1);
    let mut copies: Vec<(u32, u32, usize, String)> = Vec::new();
    // Folded per (referrer, attribute). Two copies repointed through the same
    // attribute each produced a rewrite of the whole attribute computed from
    // the untouched original, and the second overwrote the first: one copy was
    // orphaned and the referrer still pointed at the record it was supposed to
    // stop sharing. Two properties on one element is the ordinary case, so the
    // substitutions are applied in sequence to one accumulating value.
    let mut referrer_edits: HashMap<(u32, usize), String> = HashMap::new();
    for cow in &opts.copy_on_write {
        let Some(&(source_start, source_end)) = line_of.get(&cow.express_id) else {
            continue;
        };
        if !included.contains(&cow.referrer_id) {
            continue;
        }
        // The attribute has to exist before an id is spent on the copy.
        // `apply_attr_mutations` ignores an index past the end, so without this
        // the copy comes out identical to the record it copied and the referrer
        // is repointed at a duplicate that changed nothing.
        let source_line = String::from_utf8_lossy(&content[source_start..source_end]);
        if attribute_of(&source_line, cow.index).is_none() {
            continue;
        }
        let Some(&(rs, re)) = line_of.get(&cow.referrer_id) else {
            continue;
        };
        let Some(copy_id) = next_id else {
            // No id left to give it. Skipped rather than duplicated.
            continue;
        };

        // Computed against what the attribute holds now, which is the previous
        // substitution's output when there was one.
        let current = match referrer_edits.get(&(cow.referrer_id, cow.referrer_index)) {
            Some(edited) => edited.clone(),
            None => {
                let raw = String::from_utf8_lossy(&content[rs..re]);
                match attribute_of(&raw, cow.referrer_index) {
                    Some(attr) => attr,
                    None => continue,
                }
            }
        };
        let Some(rewritten) = substitute_ref_in_attr(&current, cow.express_id, copy_id) else {
            // The referrer does not hold that reference, so there is nothing to
            // repoint. Emitting the copy anyway would leave a record nothing
            // points at, and one that may reference records the export filtered
            // out. Skipped rather than half-applied.
            continue;
        };

        next_id = copy_id.checked_add(1);
        copies.push((copy_id, cow.express_id, cow.index, cow.value.clone()));
        referrer_edits.insert((cow.referrer_id, cow.referrer_index), rewritten);
    }
    for ((referrer_id, index), value) in referrer_edits {
        muts_by_id.entry(referrer_id).or_default().push((index, value));
    }

    // 3. Emit header + filtered entities (source order) + footer.
    let mut out = String::new();
    out.push_str("ISO-10303-21;\nHEADER;\n");
    out.push_str(&format!("FILE_DESCRIPTION(('{}'),'2;1');\n", escape(&opts.description)));
    out.push_str(&format!(
        "FILE_NAME('','',('{}'),('{}'),'{}','ifc-lite-export','');\n",
        escape(&opts.author),
        escape(&opts.organization),
        escape(&opts.application),
    ));
    out.push_str(&format!("FILE_SCHEMA(('{}'));\n", escape(&schema)));
    out.push_str("ENDSEC;\nDATA;\n");

    let mut written = 0usize;
    for id in &order {
        if included.contains(id) {
            if let Some(&(s, e)) = line_of.get(id) {
                let raw = String::from_utf8_lossy(&content[s..e]);
                // Apply root-attribute edits first (original-schema positions), then convert.
                let edited = match muts_by_id.get(id) {
                    Some(muts) => apply_attr_mutations(&raw, muts),
                    None => raw.into_owned(),
                };
                if converting {
                    out.push_str(&crate::schema_convert::convert_step_line(
                        &edited,
                        &source_schema,
                        &schema,
                        *id,
                    ));
                } else {
                    out.push_str(&edited);
                }
                out.push('\n');
                written += 1;
            }
        }
    }

    // The copies, emitted rather than appended: counted in `written` and put
    // through `convert_step_line` like every other record.
    for (copy_id, source_id, index, value) in &copies {
        if let Some(&(s0, e0)) = line_of.get(source_id) {
            let raw = String::from_utf8_lossy(&content[s0..e0]);
            let edited = apply_attr_mutations(&raw, &[(*index, value.clone())]);
            let renumbered = renumber(&edited, *copy_id);
            if converting {
                out.push_str(&crate::schema_convert::convert_step_line(
                    &renumbered,
                    &source_schema,
                    &schema,
                    *copy_id,
                ));
            } else {
                out.push_str(&renumbered);
            }
            out.push('\n');
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
            out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
            return (out, StepStats { total: order.len(), written });
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
                out.push_str(&format!(
                    "#{next}=IFCPROPERTYSINGLEVALUE('{}',$,{},$);\n",
                    escape(pname),
                    value
                ));
                prop_refs.push(next);
                next += 1;
                written += 1;
            }
            let psid = next;
            next += 1;
            let refs_str = prop_refs.iter().map(|r| format!("#{r}")).collect::<Vec<_>>().join(",");
            out.push_str(&format!(
                "#{psid}=IFCPROPERTYSET('{}',$,'{}',$,({}));\n",
                crate::schema_convert::placeholder_guid(psid),
                escape(pset_name),
                refs_str
            ));
            written += 1;
            let rid = next;
            next += 1;
            out.push_str(&format!(
                "#{rid}=IFCRELDEFINESBYPROPERTIES('{}',$,$,$,(#{express_id}),#{psid});\n",
                crate::schema_convert::placeholder_guid(rid),
            ));
            written += 1;
        }
    }

    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");

    (out, StepStats { total: order.len(), written })
}

#[cfg(test)]
#[path = "step_tests.rs"]
mod tests;
