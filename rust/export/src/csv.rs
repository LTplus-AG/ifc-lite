// SPDX-License-Identifier: MPL-2.0
//! CSV exporter — entities (with optional flattened property columns), one-row-per
//! property, and one-row-per-quantity. Ports `packages/export/src/csv-exporter.ts`,
//! including the spreadsheet formula-injection guard (CWE-1236) and RFC-4180 quoting.

use std::collections::{HashMap, HashSet};

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
fn escape(value: &str, delimiter: &str) -> String {
    let mut s = value.to_string();
    if let Some(first) = s.chars().next() {
        if matches!(first, '=' | '+' | '-' | '@' | '\t' | '\r') {
            s.insert(0, '\'');
        }
    }
    if s.contains(delimiter) || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
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
        let index = ifc_lite_core::build_entity_index(content);
        let mut dec = ifc_lite_core::EntityDecoder::with_index(content, index);
        if let Ok(e) = dec.decode_by_id(pid) {
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
mod tests {
    use super::*;

    fn fixture(rel: &str) -> Vec<u8> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    #[test]
    fn entities_csv_has_header_and_rows() {
        let csv = export_csv(&fixture("ara3d/duplex.ifc"), CsvMode::Entities, &CsvOptions::default());
        let mut lines = csv.lines();
        assert_eq!(lines.next().unwrap(), "expressId,globalId,name,type,description,objectType,hasGeometry");
        assert!(csv.lines().count() > 50, "expected many product rows");
        // Each data row has exactly 7 native columns (no flatten).
        for line in csv.lines().skip(1).take(20) {
            // commas inside quotes are possible; do a light field-count via a simple split is unsafe,
            // so just assert the row starts with a numeric expressId.
            assert!(line.chars().next().unwrap().is_ascii_digit());
        }
    }

    #[test]
    fn flatten_adds_property_columns() {
        let plain = export_csv(&fixture("ara3d/duplex.ifc"), CsvMode::Entities, &CsvOptions::default());
        let flat = export_csv(
            &fixture("ara3d/duplex.ifc"),
            CsvMode::Entities,
            &CsvOptions { include_properties: true, ..CsvOptions::default() },
        );
        let plain_cols = plain.lines().next().unwrap().split(',').count();
        let flat_cols = flat.lines().next().unwrap().split(',').count();
        assert!(flat_cols > plain_cols, "flatten should add Pset_Prop columns");
    }

    #[test]
    fn properties_csv_one_row_per_value() {
        let csv = export_csv(&fixture("ara3d/duplex.ifc"), CsvMode::Properties, &CsvOptions::default());
        assert_eq!(
            csv.lines().next().unwrap(),
            "entityId,globalId,entityName,entityType,psetName,propName,value,type"
        );
        assert!(csv.lines().count() > 1, "expected property rows");
    }

    #[test]
    fn spatial_hierarchy_csv() {
        let csv = export_csv(
            &fixture("ara3d/duplex.ifc"),
            CsvMode::SpatialHierarchy,
            &CsvOptions::default(),
        );
        assert_eq!(csv.lines().next().unwrap(), "expressId,globalId,name,type,parentId,level");
        assert!(csv.contains(",IfcProject,"), "project row present");
        assert!(csv.lines().count() > 3, "expected spatial nodes");
        // Exactly one root at level 0 (the project, with an empty parentId).
        let level0 = csv.lines().skip(1).filter(|l| l.ends_with(",0")).count();
        assert_eq!(level0, 1, "single root at level 0");
        // Storeys/spaces appear deeper in the tree.
        assert!(csv.contains("IfcBuildingStorey"), "storeys present in the hierarchy");
    }

    #[test]
    fn formula_injection_is_guarded() {
        assert_eq!(escape("=SUM(A1)", ","), "'=SUM(A1)");
        assert_eq!(escape("a,b", ","), "\"a,b\"");
        assert_eq!(escape("he\"llo", ","), "\"he\"\"llo\"");
        assert_eq!(escape("plain", ","), "plain");
    }
}
