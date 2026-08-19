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

use crate::step_text::{apply_attr_mutations, detect_schema, escape, refs_in_line};

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

        let mut next = max_id + 1;
        for ((express_id, pset_name), props) in &groups {
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
