// SPDX-License-Identifier: MPL-2.0
//! CSV exporter — entities (with optional flattened property columns), one-row-per
//! property, and one-row-per-quantity. Ports `packages/export/src/csv-exporter.ts`,
//! including the spreadsheet formula-injection guard (CWE-1236) and RFC-4180 quoting.

use std::collections::{HashMap, HashSet};

use crate::csv_cell::{escape_csv_cell, CsvCellOptions};
use crate::model::{build_export_model, fmt_num, EntityRow, ExportModel};

/// Which CSV view to emit.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CsvMode {
    /// One row per IfcProduct, native columns (+ flattened `Pset_Prop` columns).
    Entities,
    /// One row per property value.
    Properties,
    /// One row per quantity value.
    Quantities,
    /// One row per spatial node (project → sites → buildings → storeys → elements).
    SpatialHierarchy,
}

/// Options for CSV export.
pub struct CsvOptions {
    /// Column delimiter (default `,`).
    pub delimiter: String,
    /// Append flattened `PsetName_PropName` columns to the entities view.
    pub include_properties: bool,
}

impl Default for CsvOptions {
    fn default() -> Self {
        Self { delimiter: ",".to_string(), include_properties: false }
    }
}

/// RFC-4180 escape + spreadsheet formula-injection guard.
///
/// A thin alias over [`crate::csv_cell::escape_csv_cell`], which is THE escaper
/// for this crate. This function used to carry its own copy of the guard, and
/// that copy tested the formula trigger anchored at offset 0 — so a BOM, ZWSP,
/// LRM, NBSP or U+2028 in front of `=` sailed straight past it. Keep it a
/// delegation: `scripts/check-csv-escaper-copies.mjs` fails the build if the
/// guard is re-inlined anywhere.
fn escape(value: &str, delimiter: &str) -> String {
    // Fields spelled out rather than `..Default::default()`: a new option on a
    // security-relevant guard should force this call site to make a decision,
    // not silently inherit one.
    escape_csv_cell(
        value,
        &CsvCellOptions {
            delimiter,
            exempt_numbers: true,
            quote_whitespace_padded: false,
        },
    )
}

fn join(values: &[String], delimiter: &str) -> String {
    values.join(delimiter)
}

/// Export the requested CSV view from raw IFC bytes.
pub fn export_csv(content: &[u8], mode: CsvMode, opts: &CsvOptions) -> String {
    let model = build_export_model(content);
    match mode {
        CsvMode::Entities => entities_csv(&model, opts),
        CsvMode::Properties => properties_csv(&model, opts),
        CsvMode::Quantities => quantities_csv(&model, opts),
        CsvMode::SpatialHierarchy => spatial_csv(content, &model, opts),
    }
}

/// One row per spatial node, depth-first from the project root.
fn spatial_csv(content: &[u8], model: &ExportModel, opts: &CsvOptions) -> String {
    let d = &opts.delimiter;
    let by_id: HashMap<u32, &EntityRow> = model.entities.iter().map(|e| (e.express_id, e)).collect();
    let (children, project) = crate::ifc5::spatial_children(content);

    // The project node isn't an IfcProduct, so decode its GlobalId + Name directly.
    let (mut proj_gid, mut proj_name) = (String::new(), String::new());
    if let Some(pid) = project {
        if let Some(e) = crate::ifc5::decode_one(content, pid) {
            proj_gid = e.get(0).and_then(|a| a.as_string()).unwrap_or("").to_string();
            proj_name = e.get(2).and_then(|a| a.as_string()).unwrap_or("").to_string();
        }
    }

    let info = |id: u32| -> (String, String, String) {
        if Some(id) == project {
            (proj_gid.clone(), proj_name.clone(), "IfcProject".to_string())
        } else if let Some(e) = by_id.get(&id) {
            (
                e.global_id.clone().unwrap_or_default(),
                e.name.clone().unwrap_or_default(),
                e.ifc_type.clone(),
            )
        } else {
            (String::new(), String::new(), String::new())
        }
    };

    let headers = ["expressId", "globalId", "name", "type", "parentId", "level"];
    let mut lines = vec![join(&headers.iter().map(|h| escape(h, d)).collect::<Vec<_>>(), d)];

    let mut visited = HashSet::new();
    let mut stack: Vec<(u32, Option<u32>, usize)> = Vec::new();
    if let Some(pid) = project {
        stack.push((pid, None, 0));
    }
    while let Some((id, parent, level)) = stack.pop() {
        if !visited.insert(id) {
            continue;
        }
        let (gid, name, ty) = info(id);
        let row = vec![
            escape(&id.to_string(), d),
            escape(&gid, d),
            escape(&name, d),
            escape(&ty, d),
            escape(&parent.map(|p| p.to_string()).unwrap_or_default(), d),
            escape(&level.to_string(), d),
        ];
        lines.push(join(&row, d));
        if let Some(kids) = children.get(&id) {
            // Push reversed so siblings emit in source order.
            for &k in kids.iter().rev() {
                if !visited.contains(&k) {
                    stack.push((k, Some(id), level + 1));
                }
            }
        }
    }
    lines.join("\n")
}

fn entities_csv(model: &ExportModel, opts: &CsvOptions) -> String {
    let d = &opts.delimiter;
    let mut headers: Vec<String> = ["expressId", "globalId", "name", "type", "description", "objectType", "hasGeometry"]
        .iter()
        .map(|s| s.to_string())
        .collect();

    // Collect flattened property columns (first-seen order, deduped).
    let mut flat_cols: Vec<(String, String)> = Vec::new();
    if opts.include_properties {
        let mut seen = std::collections::HashSet::new();
        for e in &model.entities {
            for ps in &e.property_sets {
                for p in &ps.properties {
                    let key = (ps.name.clone(), p.name.clone());
                    if seen.insert(key.clone()) {
                        flat_cols.push(key);
                    }
                }
            }
        }
        for (pset, prop) in &flat_cols {
            headers.push(format!("{pset}_{prop}"));
        }
    }

    let mut lines = Vec::with_capacity(model.entities.len() + 1);
    lines.push(join(&headers.iter().map(|h| escape(h, d)).collect::<Vec<_>>(), d));

    for e in &model.entities {
        let mut row = vec![
            escape(&e.express_id.to_string(), d),
            escape(e.global_id.as_deref().unwrap_or(""), d),
            escape(e.name.as_deref().unwrap_or(""), d),
            escape(&e.ifc_type, d),
            escape(e.description.as_deref().unwrap_or(""), d),
            escape(e.object_type.as_deref().unwrap_or(""), d),
            escape(if e.has_geometry { "true" } else { "false" }, d),
        ];
        if opts.include_properties {
            for (pset, prop) in &flat_cols {
                let v = e.lookup(pset, prop).unwrap_or_default();
                row.push(escape(&v, d));
            }
        }
        lines.push(join(&row, d));
    }
    lines.join("\n")
}

fn properties_csv(model: &ExportModel, opts: &CsvOptions) -> String {
    let d = &opts.delimiter;
    let headers = ["entityId", "globalId", "entityName", "entityType", "psetName", "propName", "value", "type"];
    let mut lines = vec![join(&headers.iter().map(|h| escape(h, d)).collect::<Vec<_>>(), d)];

    for e in &model.entities {
        for ps in &e.property_sets {
            for p in &ps.properties {
                let row = vec![
                    escape(&e.express_id.to_string(), d),
                    escape(e.global_id.as_deref().unwrap_or(""), d),
                    escape(e.name.as_deref().unwrap_or(""), d),
                    escape(&e.ifc_type, d),
                    escape(&ps.name, d),
                    escape(&p.name, d),
                    escape(&p.value, d),
                    escape(&p.value_type, d),
                ];
                lines.push(join(&row, d));
            }
        }
    }
    lines.join("\n")
}

fn quantities_csv(model: &ExportModel, opts: &CsvOptions) -> String {
    let d = &opts.delimiter;
    let headers = ["entityId", "globalId", "entityName", "entityType", "qsetName", "quantityName", "value", "type"];
    let mut lines = vec![join(&headers.iter().map(|h| escape(h, d)).collect::<Vec<_>>(), d)];

    for e in &model.entities {
        for qs in &e.quantity_sets {
            for q in &qs.quantities {
                let row = vec![
                    escape(&e.express_id.to_string(), d),
                    escape(e.global_id.as_deref().unwrap_or(""), d),
                    escape(e.name.as_deref().unwrap_or(""), d),
                    escape(&e.ifc_type, d),
                    escape(&qs.name, d),
                    escape(&q.name, d),
                    escape(&fmt_num(q.value), d),
                    escape(q.kind, d),
                ];
                lines.push(join(&row, d));
            }
        }
    }
    lines.join("\n")
}

#[cfg(test)]
#[path = "csv_tests.rs"]
mod tests;
