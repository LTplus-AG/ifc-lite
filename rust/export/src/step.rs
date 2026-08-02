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

/// Escape a STEP string literal body (double single-quotes; drop control chars).
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\'' => out.push_str("''"),
            '\n' | '\r' | '\t' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

/// Detect the source `FILE_SCHEMA` label (e.g. `IFC2X3`); defaults to `IFC4`.
fn detect_schema(content: &[u8]) -> String {
    // Only look in the header region (before DATA;).
    let head_len = content.len().min(4096);
    let head = String::from_utf8_lossy(&content[..head_len]);
    if let Some(idx) = head.find("FILE_SCHEMA") {
        let rest = &head[idx..];
        if let Some(q1) = rest.find('\'') {
            if let Some(q2) = rest[q1 + 1..].find('\'') {
                let label = &rest[q1 + 1..q1 + 1 + q2];
                if !label.is_empty() {
                    return label.to_string();
                }
            }
        }
    }
    "IFC4".to_string()
}

/// Collect outgoing `#<digits>` references in a STEP entity line, skipping the
/// contents of single-quoted strings (where a `#` is literal text).
fn refs_in_line(line: &[u8], out: &mut Vec<u32>) {
    let mut i = 0;
    let mut in_quote = false;
    while i < line.len() {
        let b = line[i];
        if b == b'\'' {
            // STEP escapes a quote as '' — toggling twice is a no-op, which is fine.
            in_quote = !in_quote;
            i += 1;
            continue;
        }
        if !in_quote && b == b'#' {
            let mut j = i + 1;
            let mut n: u32 = 0;
            let mut any = false;
            while j < line.len() && line[j].is_ascii_digit() {
                n = n.wrapping_mul(10).wrapping_add((line[j] - b'0') as u32);
                j += 1;
                any = true;
            }
            if any {
                out.push(n);
                i = j;
                continue;
            }
        }
        i += 1;
    }
}

/// Split a STEP attribute list into its top-level arguments (parens/strings aware).
fn split_top_level_args(attrs: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut current = String::new();
    let bytes = attrs.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if ch == '\'' && !in_string {
            in_string = true;
            current.push(ch);
        } else if ch == '\'' && in_string {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                current.push_str("''");
                i += 2;
                continue;
            }
            in_string = false;
            current.push(ch);
        } else if in_string {
            current.push(ch);
        } else if ch == '(' {
            depth += 1;
            current.push(ch);
        } else if ch == ')' {
            depth -= 1;
            current.push(ch);
        } else if ch == ',' && depth == 0 {
            out.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
        i += 1;
    }
    out.push(current);
    out
}

/// Apply root-attribute edits to a `#id=TYPE(attrs);` line. Returns the line unchanged
/// when it cannot be parsed.
fn apply_attr_mutations(line: &str, muts: &[(usize, String)]) -> String {
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    let eq = match body.find('=') {
        Some(e) => e,
        None => return line.to_string(),
    };
    let after = &body[eq + 1..];
    let popen = match after.find('(') {
        Some(p) => p,
        None => return line.to_string(),
    };
    let aclose = match after.rfind(')') {
        Some(c) if c > popen => c,
        _ => return line.to_string(),
    };
    let prefix = &body[..=eq];
    let type_name = &after[..popen];
    let mut args = split_top_level_args(&after[popen + 1..aclose]);
    for (idx, val) in muts {
        if *idx < args.len() {
            args[*idx] = val.clone();
        }
    }
    format!("{prefix}{type_name}({});", args.join(","))
}

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
mod tests {
    use super::*;

    fn fixture(rel: &str) -> Vec<u8> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    /// Count `#id=` entity lines in a STEP DATA section + grab the FILE_SCHEMA label.
    fn parse_back(step: &str) -> (usize, HashSet<u32>, String) {
        let bytes = step.as_bytes();
        let mut ids = HashSet::new();
        let mut scanner = EntityScanner::new(bytes);
        while let Some((id, _t, _s, _e)) = scanner.next_entity() {
            ids.insert(id);
        }
        let schema = detect_schema(bytes);
        (ids.len(), ids, schema)
    }

    #[test]
    fn full_roundtrip_preserves_all_entities() {
        let src = fixture("ara3d/duplex.ifc");
        let (step, stats) = export_step_with_stats(&src, &StepOptions::default());

        // Source entity count == written count == re-parsed count.
        let (reparsed, _ids, schema) = parse_back(&step);
        assert_eq!(stats.written, stats.total, "wrote every entity");
        assert_eq!(reparsed, stats.total, "re-parse recovers every entity");
        assert!(step.starts_with("ISO-10303-21;"));
        assert!(step.trim_end().ends_with("END-ISO-10303-21;"));
        assert_eq!(schema, "IFC2X3", "preserved source schema label");
    }

    #[test]
    fn subset_export_is_reference_closed() {
        let src = fixture("ara3d/duplex.ifc");
        // Pick a real wall id from the model.
        let mut scanner = EntityScanner::new(&src[..]);
        let mut wall_id = None;
        while let Some((id, t, _s, _e)) = scanner.next_entity() {
            if t.eq_ignore_ascii_case("IFCWALLSTANDARDCASE") || t.eq_ignore_ascii_case("IFCWALL") {
                wall_id = Some(id);
                break;
            }
        }
        let wall_id = wall_id.expect("a wall in duplex");

        let (step, stats) = export_step_with_stats(
            &src,
            &StepOptions { included: Some(vec![wall_id]), ..StepOptions::default() },
        );
        let (_n, ids, _schema) = parse_back(&step);

        assert!(ids.contains(&wall_id), "the requested wall is present");
        assert!(stats.written < stats.total, "subset is smaller than the whole model");

        // Reference-closed: every #ref emitted must itself be present (no dangling refs).
        for line in step.lines().filter(|l| l.starts_with('#')) {
            let mut refs = Vec::new();
            refs_in_line(line.as_bytes(), &mut refs);
            for r in refs {
                assert!(ids.contains(&r), "dangling reference #{r} in subset export");
            }
        }
    }

    #[test]
    fn attribute_mutation_renames_entity() {
        let src = fixture("ara3d/duplex.ifc");
        // Find a wall to rename (attribute index 2 = Name on IfcRoot products).
        let mut scanner = EntityScanner::new(&src[..]);
        let mut wall_id = None;
        while let Some((id, t, _s, _e)) = scanner.next_entity() {
            if t.eq_ignore_ascii_case("IFCWALLSTANDARDCASE") {
                wall_id = Some(id);
                break;
            }
        }
        let wall_id = wall_id.expect("a wall");

        let step = export_step(
            &src,
            &StepOptions {
                attribute_mutations: vec![AttrMutation {
                    express_id: wall_id,
                    index: 2,
                    value: "'RENAMED_BY_TEST'".to_string(),
                }],
                ..StepOptions::default()
            },
        );
        // The mutated wall line carries the new name; the model still re-parses fully.
        let line = step
            .lines()
            .find(|l| l.starts_with(&format!("#{wall_id}=")))
            .expect("wall line present");
        assert!(line.contains("'RENAMED_BY_TEST'"), "name replaced: {line}");
        let (reparsed, _ids, _schema) = parse_back(&step);
        let mut sc = EntityScanner::new(&src[..]);
        let mut total = 0usize;
        while sc.next_entity().is_some() {
            total += 1;
        }
        assert_eq!(reparsed, total, "no entities dropped by the edit");
    }

    #[test]
    fn property_synthesis_attaches_new_pset() {
        let src = fixture("ara3d/duplex.ifc");
        let mut scanner = EntityScanner::new(&src[..]);
        let mut wall = None;
        while let Some((id, t, _s, _e)) = scanner.next_entity() {
            if t.eq_ignore_ascii_case("IFCWALLSTANDARDCASE") {
                wall = Some(id);
                break;
            }
        }
        let wall = wall.expect("a wall");

        let (step, stats) = export_step_with_stats(
            &src,
            &StepOptions {
                property_mutations: vec![PropMutation {
                    express_id: wall,
                    pset_name: "Pset_Test".to_string(),
                    prop_name: "MyProp".to_string(),
                    value: "IFCLABEL('hello')".to_string(),
                }],
                ..StepOptions::default()
            },
        );

        // The three synthesized entities are present.
        assert!(
            step.contains("=IFCPROPERTYSINGLEVALUE('MyProp',$,IFCLABEL('hello'),$);"),
            "single value synthesized"
        );
        assert!(step.contains("'Pset_Test'"), "pset name present");
        // The synthesized rel ($-owner/name/desc) relates the wall to the new pset —
        // distinct from duplex's original rels which carry a real OwnerHistory ref.
        let synth_rel = format!(",$,$,$,(#{wall}),#");
        assert!(
            step.lines().any(|l| l.contains("=IFCRELDEFINESBYPROPERTIES(") && l.contains(&synth_rel)),
            "synthesized rel targeting the wall not found"
        );

        // Re-parses, and the synthesized entities are counted (written = original + 3).
        let (reparsed, _ids, _schema) = parse_back(&step);
        assert_eq!(reparsed, stats.written, "every written entity re-parses");
        assert_eq!(stats.written, stats.total + 3, "added 1 prop + 1 pset + 1 rel");
    }

    #[test]
    fn split_top_level_args_respects_nesting() {
        let args = "'a',$,(#1,#2,#3),IFCBOOLEAN(.T.),#9";
        let parts = split_top_level_args(args);
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[2], "(#1,#2,#3)");
        assert_eq!(parts[3], "IFCBOOLEAN(.T.)");
    }

    #[test]
    fn schema_conversion_to_ifc4_keeps_model_parseable() {
        let src = fixture("ara3d/duplex.ifc");
        let (step, stats) = export_step_with_stats(
            &src,
            &StepOptions { schema: Some("IFC4".to_string()), ..StepOptions::default() },
        );
        assert!(step.contains("FILE_SCHEMA(('IFC4'))"));
        // Conversion preserves every express id (renames type, never drops entities).
        let (reparsed, _ids, schema) = parse_back(&step);
        assert_eq!(reparsed, stats.total, "no entities lost in conversion");
        assert_eq!(schema, "IFC4");
        // The converted file must still re-parse as a coherent entity set.
        assert!(step.lines().filter(|l| l.starts_with('#')).count() == stats.written);
    }
}
