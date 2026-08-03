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

use std::collections::{HashMap, HashSet};
use std::fmt::Write;

use ifc_lite_processing::{process_geometry, MeshData};

use crate::ifc5::{project_name, spatial_children};
use crate::model::{build_export_model, EntityRow};

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
    write_header(&mut out, opts);

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

/// Shared read-only context threaded through the recursive emitter.
struct Ctx<'a> {
    children: &'a HashMap<u32, Vec<u32>>,
    info: &'a HashMap<u32, (String, String)>,
    by_id: &'a HashMap<u32, &'a EntityRow>,
    meshes_by_id: &'a HashMap<u32, Vec<&'a MeshData>>,
}

/// Emit one prim (`def Xform`) plus its submeshes and spatial children. `indent` is
/// the brace depth of THIS prim (root World children are at indent 1).
fn emit_prim(
    out: &mut String,
    ctx: &Ctx,
    id: u32,
    indent: usize,
    depth: usize,
    emitted: &mut HashSet<u32>,
    siblings: &mut Namer,
) {
    if !emitted.insert(id) {
        return; // already emitted under another parent (or a duplicate edge)
    }
    let (name, ifc_type) = ctx
        .info
        .get(&id)
        .cloned()
        .unwrap_or_else(|| (String::new(), "IfcProduct".to_string()));
    let prim = siblings.alloc(&prim_name(&name, &ifc_type, id));
    let pad = indent_str(indent);

    writeln!(out, "\n{pad}def Xform \"{prim}\"").ok();
    writeln!(out, "{pad}{{").ok();

    emit_attributes(out, indent + 1, &ifc_type, ctx.by_id.get(&id).copied());

    // Children of THIS prim: its submeshes, then its spatial child elements. Both
    // share one namer so a mesh name can never collide with a child element prim.
    let mut child_names = Namer::new();

    if let Some(meshes) = ctx.meshes_by_id.get(&id) {
        for m in meshes {
            let mesh_name = child_names.alloc("geom");
            emit_mesh(out, indent + 1, &mesh_name, m);
        }
    }

    if depth < MAX_DEPTH {
        if let Some(kids) = ctx.children.get(&id) {
            for &cid in kids {
                emit_prim(out, ctx, cid, indent + 1, depth + 1, emitted, &mut child_names);
            }
        }
    }

    writeln!(out, "{pad}}}").ok();
}

/// Emit the IFC metadata block for an element prim as namespaced custom attributes.
/// Per-prim name dedup: two properties whose names collide after sanitizing (or two
/// like-named psets) must not emit the same attribute spec twice — a duplicate spec is
/// an Sdf parse error.
fn emit_attributes(out: &mut String, indent: usize, ifc_type: &str, row: Option<&EntityRow>) {
    let pad = indent_str(indent);
    let mut used: HashSet<String> = HashSet::new();

    let put_string = |out: &mut String, used: &mut HashSet<String>, attr: &str, val: &str| {
        if used.insert(attr.to_string()) {
            writeln!(out, "{pad}custom string {attr} = \"{}\"", escape_str(val)).ok();
        }
    };

    put_string(out, &mut used, "ifc:class", ifc_type);
    if let Some(r) = row {
        if let Some(g) = &r.global_id {
            put_string(out, &mut used, "ifc:globalId", g);
        }
        if let Some(n) = &r.name {
            put_string(out, &mut used, "ifc:name", n);
        }
        if let Some(d) = &r.description {
            put_string(out, &mut used, "ifc:description", d);
        }
        for ps in &r.property_sets {
            let pset = sanitize_ident(&ps.name, "Pset");
            for p in &ps.properties {
                let attr = format!("ifc:pset:{pset}:{}", sanitize_ident(&p.name, "Prop"));
                put_string(out, &mut used, &attr, &p.value);
            }
        }
        for qs in &r.quantity_sets {
            let qset = sanitize_ident(&qs.name, "Qto");
            for q in &qs.quantities {
                if !q.value.is_finite() {
                    continue;
                }
                let attr = format!("ifc:qty:{qset}:{}", sanitize_ident(&q.name, "Qty"));
                if used.insert(attr.clone()) {
                    writeln!(out, "{pad}custom double {attr} = {}", fmt_f64(q.value)).ok();
                }
            }
        }
    }
}

/// Emit one `UsdGeomMesh` prim. `positions` are authored verbatim as object-LOCAL
/// `point3f[]` (small, f32-precise); the per-mesh f64 `origin` becomes a `double3
/// xformOp:translate` so placement keeps full precision at any model extent. Binds a
/// material and applies `MaterialBindingAPI`.
fn emit_mesh(out: &mut String, indent: usize, name: &str, m: &MeshData) {
    let pad = indent_str(indent);
    let inner = indent_str(indent + 1);

    // Local f32 points + running extent (object space, so the extent is placement-free).
    let vcount = m.positions.len() / 3;
    let mut pts = String::new();
    let mut ext_min = [f32::INFINITY; 3];
    let mut ext_max = [f32::NEG_INFINITY; 3];
    for k in 0..vcount {
        for j in 0..3 {
            let v = m.positions[k * 3 + j];
            if v < ext_min[j] {
                ext_min[j] = v;
            }
            if v > ext_max[j] {
                ext_max[j] = v;
            }
        }
        if k > 0 {
            pts.push_str(", ");
        }
        write!(
            pts,
            "({}, {}, {})",
            fmt_f32(m.positions[k * 3]),
            fmt_f32(m.positions[k * 3 + 1]),
            fmt_f32(m.positions[k * 3 + 2])
        )
        .ok();
    }

    // Normals (1:1 with points → vertex interpolation).
    let mut nrm = String::new();
    for k in 0..vcount {
        if k > 0 {
            nrm.push_str(", ");
        }
        write!(
            nrm,
            "({}, {}, {})",
            fmt_f32(m.normals[k * 3]),
            fmt_f32(m.normals[k * 3 + 1]),
            fmt_f32(m.normals[k * 3 + 2])
        )
        .ok();
    }

    // faceVertexCounts (all triangles) + indices.
    let tri = m.indices.len() / 3;
    let counts = std::iter::repeat_n("3", tri).collect::<Vec<_>>().join(", ");
    let idx = m.indices.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ");

    let c = clamp_color(m.color);
    let key = color_key(m.color);
    let mat = mat_name(key);

    writeln!(out, "\n{pad}def Mesh \"{name}\" (").ok();
    writeln!(out, "{inner}prepend apiSchemas = [\"MaterialBindingAPI\"]").ok();
    writeln!(out, "{pad})").ok();
    writeln!(out, "{pad}{{").ok();
    writeln!(out, "{inner}uniform bool doubleSided = 1").ok();
    writeln!(out, "{inner}uniform token subdivisionScheme = \"none\"").ok();
    writeln!(
        out,
        "{inner}float3[] extent = [({}, {}, {}), ({}, {}, {})]",
        fmt_f32(ext_min[0]),
        fmt_f32(ext_min[1]),
        fmt_f32(ext_min[2]),
        fmt_f32(ext_max[0]),
        fmt_f32(ext_max[1]),
        fmt_f32(ext_max[2])
    )
    .ok();
    writeln!(out, "{inner}int[] faceVertexCounts = [{counts}]").ok();
    writeln!(out, "{inner}int[] faceVertexIndices = [{idx}]").ok();
    writeln!(out, "{inner}point3f[] points = [{pts}]").ok();
    writeln!(out, "{inner}normal3f[] normals = [{nrm}] (").ok();
    writeln!(out, "{}interpolation = \"vertex\"", indent_str(indent + 2)).ok();
    writeln!(out, "{inner})").ok();
    writeln!(
        out,
        "{inner}color3f[] primvars:displayColor = [({}, {}, {})]",
        fmt_f32(c[0]),
        fmt_f32(c[1]),
        fmt_f32(c[2])
    )
    .ok();
    writeln!(out, "{inner}float[] primvars:displayOpacity = [{}]", fmt_f32(c[3])).ok();
    writeln!(out, "{inner}rel material:binding = </World/Looks/{mat}>").ok();
    // Per-mesh placement: the f64 origin as a double3 translate (omitted when zero —
    // local positions are then already the world coordinates).
    if m.origin.iter().any(|v| v.abs() > 0.0) {
        writeln!(
            out,
            "{inner}double3 xformOp:translate = ({}, {}, {})",
            fmt_f64(m.origin[0]),
            fmt_f64(m.origin[1]),
            fmt_f64(m.origin[2])
        )
        .ok();
        writeln!(out, "{inner}uniform token[] xformOpOrder = [\"xformOp:translate\"]").ok();
    }
    writeln!(out, "{pad}}}").ok();
}

/// Emit one `UsdPreviewSurface` material for a rounded colour key.
fn emit_material(out: &mut String, indent: usize, key: (i32, i32, i32, i32), color: [f32; 4]) {
    let pad = indent_str(indent);
    let inner = indent_str(indent + 1);
    let inner2 = indent_str(indent + 2);
    let name = mat_name(key);
    let c = clamp_color(color);

    writeln!(out, "{pad}def Material \"{name}\"").ok();
    writeln!(out, "{pad}{{").ok();
    writeln!(
        out,
        "{inner}token outputs:surface.connect = </World/Looks/{name}/Surface.outputs:surface>"
    )
    .ok();
    writeln!(out, "\n{inner}def Shader \"Surface\"").ok();
    writeln!(out, "{inner}{{").ok();
    writeln!(out, "{inner2}uniform token info:id = \"UsdPreviewSurface\"").ok();
    writeln!(
        out,
        "{inner2}color3f inputs:diffuseColor = ({}, {}, {})",
        fmt_f32(c[0]),
        fmt_f32(c[1]),
        fmt_f32(c[2])
    )
    .ok();
    writeln!(out, "{inner2}float inputs:opacity = {}", fmt_f32(c[3])).ok();
    writeln!(out, "{inner2}float inputs:metallic = 0").ok();
    writeln!(out, "{inner2}float inputs:roughness = 1").ok();
    writeln!(out, "{inner2}token outputs:surface").ok();
    writeln!(out, "{inner}}}").ok();
    writeln!(out, "{pad}}}").ok();
}

/// Layer metadata block. `upAxis` / `metersPerUnit` / `defaultPrim` are LAYER metadata
/// (not prim attrs); `author` has no registered layer field so it goes in
/// `customLayerData`.
fn write_header(out: &mut String, opts: &UsdOptions) {
    out.push_str("#usda 1.0\n(\n");
    out.push_str("    defaultPrim = \"World\"\n");
    out.push_str("    doc = \"Generated by ifc-lite\"\n");
    out.push_str("    metersPerUnit = 1\n");
    out.push_str("    upAxis = \"Z\"\n");
    out.push_str("    customLayerData = {\n");
    writeln!(out, "        string author = \"{}\"", escape_str(&opts.author)).ok();
    out.push_str("    }\n)\n\n");
}

// ── mesh / geometry gates ───────────────────────────────────────────────────

/// Emittable-mesh gate: the glTF `mesh_visible` geometry sanity (no instanced
/// type-library duplicates, matched non-empty triangulated buffers) PLUS the
/// USD-specific guards that keep the stage parseable/checkable: all-finite
/// coordinates and every index within the vertex range.
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

// ── materials ───────────────────────────────────────────────────────────────

/// Material dedup key: RGBA rounded to 2 decimals, clamped to 0..=100 (matches the
/// glTF exporter's key; the clamp keeps the derived prim name a legal identifier even
/// for an out-of-gamut IFC colour).
fn color_key(c: [f32; 4]) -> (i32, i32, i32, i32) {
    let r = |v: f32| {
        let v = if v.is_finite() { v } else { 0.0 };
        ((v * 100.0).round() as i32).clamp(0, 100)
    };
    (r(c[0]), r(c[1]), r(c[2]), r(c[3]))
}

/// Legal-identifier material prim name from a (clamped, non-negative) colour key.
fn mat_name(key: (i32, i32, i32, i32)) -> String {
    format!("Mat_{}_{}_{}_{}", key.0, key.1, key.2, key.3)
}

/// Clamp an RGBA colour into the [0,1] range USD expects (non-finite → mid-grey/opaque).
fn clamp_color(c: [f32; 4]) -> [f32; 4] {
    let f = |v: f32, d: f32| if v.is_finite() { v.clamp(0.0, 1.0) } else { d };
    [f(c[0], 0.8), f(c[1], 0.8), f(c[2], 0.8), f(c[3], 1.0)]
}

// ── string / number / identifier helpers ────────────────────────────────────

/// Sanitize a string to a USD identifier segment: `[A-Za-z_][A-Za-z0-9_]*`. Empty or
/// leading-non-alpha inputs get the fallback prefix.
fn sanitize_ident(s: &str, fallback: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if out.is_empty() || !out.chars().next().unwrap().is_ascii_alphabetic() && !out.starts_with('_') {
        out = format!("{fallback}_{out}");
    }
    out
}

/// USD prim name for an element: sanitized display-name (or type) + `_<express id>`
/// so element siblings are always unique regardless of name collisions.
fn prim_name(name: &str, fallback_type: &str, id: u32) -> String {
    let base = if name.trim().is_empty() { fallback_type } else { name };
    let mut out: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if out.is_empty() || !(out.chars().next().unwrap().is_ascii_alphabetic() || out.starts_with('_')) {
        out = format!("p_{out}");
    }
    format!("{out}_{id}")
}

/// Escape a Rust string for a USD `"..."` literal.
fn escape_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {} // drop other control chars
            c => out.push(c),
        }
    }
    out
}

/// Shortest round-trip f32, with non-finite mapped to `0` (usda has no `NaN`/`inf`
/// literal spelling matching Rust's `Display`, and a non-finite slips past the gates
/// only for derived values like the mid-vertex normal of a zero-area face).
fn fmt_f32(v: f32) -> String {
    if v.is_finite() {
        format!("{v}")
    } else {
        "0".to_string()
    }
}

/// Shortest round-trip f64, non-finite → `0`.
fn fmt_f64(v: f64) -> String {
    if v.is_finite() {
        format!("{v}")
    } else {
        "0".to_string()
    }
}

fn indent_str(level: usize) -> String {
    "    ".repeat(level)
}

/// Allocates unique child prim names within a single parent scope.
struct Namer {
    used: HashSet<String>,
}

impl Namer {
    fn new() -> Self {
        Self { used: HashSet::new() }
    }

    /// Reserve a name (for fixed structural children like `Looks` / `Unassigned`).
    fn reserve(&mut self, name: &str) {
        self.used.insert(name.to_string());
    }

    /// Return `base`, or `base_2`, `base_3`, … if already taken in this scope.
    fn alloc(&mut self, base: &str) -> String {
        if self.used.insert(base.to_string()) {
            return base.to_string();
        }
        let mut n = 2;
        loop {
            let cand = format!("{base}_{n}");
            if self.used.insert(cand.clone()) {
                return cand;
            }
            n += 1;
        }
    }
}

#[cfg(test)]
mod tests;
