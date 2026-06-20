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

/// Options for STEP export.
pub struct StepOptions {
    /// FILE_SCHEMA label to write (e.g. `IFC4`). `None` ⇒ preserve the source schema.
    /// Note: this only rewrites the header label; entity-type conversion is P2.
    pub schema: Option<String>,
    /// Express ids to include. `None` ⇒ the whole model. When set, the forward
    /// reference closure is added so every emitted `#ref` resolves.
    pub included: Option<Vec<u32>>,
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

/// Export the parsed model in `content` as a STEP/IFC string.
pub fn export_step(content: &[u8], opts: &StepOptions) -> String {
    export_step_with_stats(content, opts).0
}

/// Like [`export_step`] but also returns coverage stats.
pub fn export_step_with_stats(content: &[u8], opts: &StepOptions) -> (String, StepStats) {
    // 1. Index every entity line (preserve source order).
    let mut order: Vec<u32> = Vec::new();
    let mut line_of: HashMap<u32, (usize, usize)> = HashMap::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, _type, start, end)) = scanner.next_entity() {
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

    let schema = opts.schema.clone().unwrap_or_else(|| detect_schema(content));

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
                out.push_str(&String::from_utf8_lossy(&content[s..e]));
                out.push('\n');
                written += 1;
            }
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
    fn schema_label_override() {
        let src = fixture("ara3d/duplex.ifc");
        let step = export_step(
            &src,
            &StepOptions { schema: Some("IFC4".to_string()), ..StepOptions::default() },
        );
        assert!(step.contains("FILE_SCHEMA(('IFC4'))"));
    }
}
