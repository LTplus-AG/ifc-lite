// SPDX-License-Identifier: MPL-2.0
//! **Merged** multi-model STEP exporter. Ports the core of `merged-exporter.ts`:
//! combine several IFC files into one by ID-offsetting each subsequent model and
//! rewriting every `#`-reference. The first model keeps its ids; each later model is
//! shifted past the running maximum.
//!
//! P1 unifies the **project**: subsequent models' `IfcProject` lines are dropped and any
//! reference to them is redirected to the first model's project, so the result is a single
//! valid `IfcProject` tree. Deeper shared-infrastructure dedup (units, contexts) and
//! spatial unification by name/elevation are the P2 follow-on.

use ifc_lite_core::EntityScanner;

/// Options for merged export.
pub struct MergedOptions {
    pub schema: Option<String>,
    pub description: String,
    pub application: String,
}

impl Default for MergedOptions {
    fn default() -> Self {
        Self {
            schema: None,
            description: "ViewDefinition [CoordinationView]".to_string(),
            application: "ifc-lite".to_string(),
        }
    }
}

/// Coverage stats for a merged export.
pub struct MergedStats {
    pub models: usize,
    pub written: usize,
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            // ISO 10303-21 doubles both the apostrophe and the reverse
            // solidus inside a string literal; each is independent of the
            // other (order in the source string is preserved as-is).
            '\'' => out.push_str("''"),
            '\\' => out.push_str("\\\\"),
            '\n' | '\r' | '\t' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

fn detect_schema(content: &[u8]) -> String {
    let head = String::from_utf8_lossy(&content[..content.len().min(4096)]);
    if let Some(i) = head.find("FILE_SCHEMA") {
        let r = &head[i..];
        if let Some(q1) = r.find('\'') {
            if let Some(q2) = r[q1 + 1..].find('\'') {
                let l = &r[q1 + 1..q1 + 1 + q2];
                if !l.is_empty() {
                    // `l` is the RAW, still-STEP-escaped slice between the
                    // first two quotes (the doubled-apostrophe case is a
                    // separate, already-tracked quote-scanning bound: see
                    // fix/merged-detect-schema-quote2). It is about to be
                    // fed straight into `escape()` when the header is
                    // re-written, which doubles `\` again -- un-double it
                    // here first so a schema label carrying a literal `\`
                    // round-trips instead of being re-escaped on top of
                    // its own escaping. A no-op for every real schema
                    // label (IFC2X3, IFC4, IFC4X3_ADD2, ...), none of
                    // which contain a backslash.
                    return l.replace("\\\\", "\\");
                }
            }
        }
    }
    "IFC4".to_string()
}

/// First `IfcProject` express id in a model, if any.
fn find_project(content: &[u8]) -> Option<u32> {
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, _s, _e)) = scanner.next_entity() {
        if type_name == "IFCPROJECT" {
            return Some(id);
        }
    }
    None
}

/// Rewrite every `#N` in a STEP entity line. `remap(n)` returns `Some(absolute_id)` to
/// redirect a reference (no offset), or `None` to apply `offset`. Single-quoted strings
/// are left untouched (a `#` there is literal text).
fn rewrite_refs(line: &[u8], offset: u32, remap: &impl Fn(u32) -> Option<u32>) -> String {
    let mut out = String::with_capacity(line.len() + 8);
    let mut i = 0;
    let mut in_string = false;
    while i < line.len() {
        let b = line[i];
        if b == b'\'' {
            in_string = !in_string;
            out.push('\'');
            i += 1;
            continue;
        }
        if !in_string && b == b'#' {
            let mut j = i + 1;
            let mut n: u32 = 0;
            let mut any = false;
            while j < line.len() && line[j].is_ascii_digit() {
                n = n.wrapping_mul(10).wrapping_add((line[j] - b'0') as u32);
                j += 1;
                any = true;
            }
            if any {
                let target = remap(n).unwrap_or(n.wrapping_add(offset));
                out.push('#');
                out.push_str(&target.to_string());
                i = j;
                continue;
            }
        }
        out.push(b as char);
        i += 1;
    }
    out
}

/// Merge `models` (raw IFC byte slices) into one STEP/IFC string.
pub fn export_merged(models: &[&[u8]], opts: &MergedOptions) -> String {
    export_merged_with_stats(models, opts).0
}

/// Like [`export_merged`] but also returns coverage stats.
pub fn export_merged_with_stats(models: &[&[u8]], opts: &MergedOptions) -> (String, MergedStats) {
    let schema = opts
        .schema
        .clone()
        .or_else(|| models.first().map(|m| detect_schema(m)))
        .unwrap_or_else(|| "IFC4".to_string());

    let canonical_project = models.first().and_then(|m| find_project(m));

    let mut out = String::new();
    out.push_str("ISO-10303-21;\nHEADER;\n");
    out.push_str(&format!("FILE_DESCRIPTION(('{}'),'2;1');\n", escape(&opts.description)));
    out.push_str(&format!(
        "FILE_NAME('','',(''),(''),'{}','ifc-lite-export','');\n",
        escape(&opts.application)
    ));
    out.push_str(&format!("FILE_SCHEMA(('{}'));\n", escape(&schema)));
    out.push_str("ENDSEC;\nDATA;\n");

    let mut offset: u32 = 0;
    let mut written = 0usize;
    for (i, content) in models.iter().enumerate() {
        let model_project = find_project(content);
        let mut local_max = 0u32;
        let mut scanner = EntityScanner::new(content);
        let mut lines: Vec<(u32, &[u8])> = Vec::new();
        while let Some((id, _t, s, e)) = scanner.next_entity() {
            local_max = local_max.max(id);
            lines.push((id, &content[s..e]));
        }

        let is_first = i == 0;
        let remap = |n: u32| -> Option<u32> {
            // Subsequent models: redirect their project reference to model 0's project.
            if !is_first {
                if let (Some(mp), Some(cp)) = (model_project, canonical_project) {
                    if n == mp {
                        return Some(cp);
                    }
                }
            }
            None
        };

        for (id, line) in &lines {
            // Drop later models' IfcProject lines (the project is unified to model 0's).
            if !is_first && Some(*id) == model_project {
                continue;
            }
            out.push_str(&rewrite_refs(line, offset, &remap));
            out.push('\n');
            written += 1;
        }
        offset = offset.wrapping_add(local_max).wrapping_add(1);
    }

    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    (out, MergedStats { models: models.len(), written })
}

#[cfg(test)]
#[path = "merged_tests.rs"]
mod tests;
