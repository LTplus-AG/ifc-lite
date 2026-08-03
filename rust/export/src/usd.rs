// SPDX-License-Identifier: MPL-2.0
//! OpenUSD (**USDA** ASCII) exporter — a real `.usda` stage, not the USD-flavored
//! JSON that IFCX emits. Produces a **Z-up** scene graph of `Xform` prims mirroring
//! the IFC spatial hierarchy (Project → Site → Building → Storey → element); each
//! geometry-bearing element carries `UsdGeomMesh` prims with `UsdPreviewSurface`
//! materials and IFC metadata as namespaced custom attributes. Opens in usdview /
//! Blender / Omniverse; targets `usdchecker` validity.
//!
//! Geometry source = `ifc_lite_processing::process_geometry` (Z-up, **metres** — the
//! router bakes the length-unit scale at mesh time). So the stage is authored
//! `upAxis = "Z"`, `metersPerUnit = 1` with NO basis/scale conversion (unlike glTF).
//!
//! Precision: each `MeshData` stores object-local f32 `positions` relative to a per-mesh
//! f64 `origin` (the RTC/placement offset). We author `positions` verbatim as local
//! `point3f[]` and carry `origin` as a **double3 `xformOp:translate`** on each Mesh
//! prim — so a georeferenced / national-grid model keeps full f64 placement precision
//! with small (object-scale) f32 vertices, at any model extent. Element Xforms are pure
//! identity grouping.
//!
//! Emission (`emit`) and lexical helpers (`fmt`) live in submodules; this file is the
//! orchestration + the emittable-mesh gate.

mod emit;
mod fmt;

use std::collections::{HashMap, HashSet};

use ifc_lite_processing::{process_geometry, MeshData};

use crate::ifc5::{project_name, spatial_children};
use crate::model::{build_export_model, EntityRow};
use emit::{emit_material, emit_prim, write_header, Ctx};
use fmt::{color_key, Namer};

/// Deepest spatial nesting the recursive emitter follows before it stops recursing
/// (the subtree is then caught by the leftover / Unassigned pass). IFC spatial trees
/// are shallow; this only guards against a pathological / cyclic aggregation graph
/// blowing the stack.
const MAX_DEPTH: usize = 64;

/// Options for USD (USDA) export.
pub struct UsdOptions {
    /// Written to `customLayerData.author` (a bare `author` layer metadatum is
    /// unregistered and would fail `usdchecker`).
    pub author: String,
}

impl Default for UsdOptions {
    fn default() -> Self {
        Self { author: "ifc-lite".to_string() }
    }
}

/// Export the model in `content` (raw IFC/STEP bytes) as a `.usda` (ASCII USD) string.
pub fn export_usd(content: &[u8], opts: &UsdOptions) -> String {
    let result = process_geometry(content);

    // Emittable meshes: mirror the glTF `mesh_visible` sanity gate (drop the instanced
    // type-library class, require matched non-empty triangulated buffers) and add the
    // USD-specific guards — all-finite coordinates and in-range indices — so a
    // degenerate mesh can never emit non-finite `point3f`/`normal3f` (an usda parse
    // error) or an out-of-range `faceVertexIndices` (an usdchecker error).
    let visible: Vec<&MeshData> = result.meshes.iter().filter(|m| mesh_emittable(m)).collect();

    // Group meshes by express id (an element may produce several submeshes), keeping a
    // first-appearance ORDER so the Unassigned bucket and output stay deterministic.
    let mut meshes_by_id: HashMap<u32, Vec<&MeshData>> = HashMap::new();
    let mut mesh_order: Vec<u32> = Vec::new();
    {
        let mut seen: HashSet<u32> = HashSet::new();
        for m in &visible {
            if seen.insert(m.express_id) {
                mesh_order.push(m.express_id);
            }
            meshes_by_id.entry(m.express_id).or_default().push(m);
        }
    }

    // Attribute rows (GlobalId / class / Name / psets / quantities), keyed by id.
    let model = build_export_model(content);
    let by_id: HashMap<u32, &EntityRow> =
        model.entities.iter().map(|e| (e.express_id, e)).collect();

    // (display-name, ifc-type) per id: rows first, then the IfcProject (not an
    // IfcProduct → not in the model), then any meshed id lacking a row (fall back to
    // the mesh's own metadata so a geometry-only element still gets a typed prim).
    let mut info: HashMap<u32, (String, String)> = HashMap::new();
    for e in &model.entities {
        info.insert(e.express_id, (e.name.clone().unwrap_or_default(), e.ifc_type.clone()));
    }

    // Spatial parent→children edges + the IfcProject id.
    let (children, project) = spatial_children(content);
    if let Some(pid) = project {
        info.entry(pid)
            .or_insert_with(|| (project_name(content, pid), "IfcProject".to_string()));
    }
    for id in &mesh_order {
        if !info.contains_key(id) {
            if let Some(m) = meshes_by_id.get(id).and_then(|v| v.first()) {
                info.insert(*id, (m.name.clone().unwrap_or_default(), m.ifc_type.clone()));
            }
        }
    }

    // Materials: distinct rounded RGBA keys over the emitted meshes, one
    // UsdPreviewSurface each, sorted for determinism.
    let mut mat_color: HashMap<(i32, i32, i32, i32), [f32; 4]> = HashMap::new();
    for m in &visible {
        mat_color.entry(color_key(m.color)).or_insert(m.color);
    }
    let mut mat_keys: Vec<(i32, i32, i32, i32)> = mat_color.keys().copied().collect();
    mat_keys.sort_unstable();

    let ctx = Ctx { children: &children, info: &info, by_id: &by_id, meshes_by_id: &meshes_by_id };

    // ── Emit ────────────────────────────────────────────────────────────────
    let mut out = String::new();
    write_header(&mut out, opts, content);

    // Root /World Xform (identity — per-mesh placement rides each Mesh's translate).
    out.push_str("def Xform \"World\"\n{\n");

    // Materials under /World/Looks.
    let mut world_names = Namer::new();
    world_names.reserve("Looks");
    if !mat_keys.is_empty() {
        out.push_str("\n    def Scope \"Looks\"\n    {\n");
        for key in &mat_keys {
            emit_material(&mut out, 2, *key, mat_color[key]);
        }
        out.push_str("    }\n");
    }

    let mut emitted: HashSet<u32> = HashSet::new();

    // Spatial subtree from the project (recursive DFS, first-parent-wins).
    if let Some(pid) = project {
        emit_prim(&mut out, &ctx, pid, 1, 0, &mut emitted, &mut world_names);
    }

    // Leftover meshed ids the spatial walk never reached (type-product geometry keyed
    // by the type's own id; elements aggregated/nested outside spatial structure).
    // NEVER silently dropped — the join-completeness guarantee.
    let leftover: Vec<u32> =
        mesh_order.iter().copied().filter(|id| !emitted.contains(id)).collect();
    if !leftover.is_empty() {
        if project.is_some() {
            // Park them under a synthetic sibling so the project tree stays clean.
            world_names.reserve("Unassigned");
            out.push_str("\n    def Xform \"Unassigned\"\n    {\n");
            // A leftover id may itself have spatial children; `emit_prim` recurses, so
            // that subtree lands under Unassigned. Later `leftover` iterations for those
            // same ids no-op via the `emitted` guard — no drop, no double-emit.
            let mut un_names = Namer::new();
            for id in &leftover {
                emit_prim(&mut out, &ctx, *id, 2, 0, &mut emitted, &mut un_names);
            }
            out.push_str("    }\n");
        } else {
            // No project at all → emit meshed elements directly under /World.
            for id in &leftover {
                emit_prim(&mut out, &ctx, *id, 1, 0, &mut emitted, &mut world_names);
            }
        }
    }

    out.push_str("}\n");
    out
}

/// Emittable-mesh gate: the glTF `mesh_visible` geometry sanity (no instanced
/// type-library duplicates, matched non-empty triangulated buffers) PLUS the
/// USD-specific guards that keep the stage parseable/checkable: all-finite
/// coordinates, a finite per-mesh origin, and every index within the vertex range.
fn mesh_emittable(m: &MeshData) -> bool {
    if m.geometry_class == 2 {
        return false;
    }
    // Triangulated: index buffer is whole triangles (so faceVertexCounts of all-3s
    // sums to the index count — else usdchecker rejects the mesh).
    if m.indices.len() < 3 || !m.indices.len().is_multiple_of(3) {
        return false;
    }
    if m.positions.len() < 9 || !m.positions.len().is_multiple_of(3) {
        return false;
    }
    if m.normals.len() != m.positions.len() {
        return false;
    }
    if !m.positions.iter().all(|v| v.is_finite()) || !m.normals.iter().all(|v| v.is_finite()) {
        return false;
    }
    // The per-mesh origin becomes a double3 translate; a non-finite one would
    // silently mislocate the mesh (fmt maps it to 0), so gate it out.
    if !m.origin.iter().all(|v| v.is_finite()) {
        return false;
    }
    let vcount = (m.positions.len() / 3) as u32;
    m.indices.iter().all(|&i| i < vcount)
}

#[cfg(test)]
mod tests;
