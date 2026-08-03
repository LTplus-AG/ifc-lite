// SPDX-License-Identifier: MPL-2.0
//! USDA prim emission: the recursive `Xform` walk, `UsdGeomMesh` geometry,
//! `UsdPreviewSurface` materials, the IFC-metadata attribute block, and the layer header.

use std::collections::{HashMap, HashSet};
use std::fmt::Write;

use ifc_lite_processing::MeshData;

use super::fmt::{
    clamp_color, color_key, escape_str, fmt_f32, fmt_f64, indent_str, mat_name, prim_name,
    sanitize_ident, Namer,
};
use super::{UsdOptions, MAX_DEPTH};
use crate::model::EntityRow;

/// Shared read-only context threaded through the recursive emitter.
pub(super) struct Ctx<'a> {
    pub(super) children: &'a HashMap<u32, Vec<u32>>,
    pub(super) info: &'a HashMap<u32, (String, String)>,
    pub(super) by_id: &'a HashMap<u32, &'a EntityRow>,
    pub(super) meshes_by_id: &'a HashMap<u32, Vec<&'a MeshData>>,
}

/// Emit one prim (`def Xform`) plus its submeshes and spatial children. `indent` is
/// the brace depth of THIS prim (root World children are at indent 1).
pub(super) fn emit_prim(
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
/// Attribute leaves use the exact PascalCase IFC EXPRESS names (`GlobalId`, `Name`,
/// `Description`); `ifc:class` is the IFC *type*, not an EXPRESS attribute, so it stays
/// lower-case. Per-prim name dedup: two properties whose names collide after sanitizing
/// (or two like-named psets) must not emit the same attribute spec twice — a duplicate
/// spec is an Sdf parse error.
pub(super) fn emit_attributes(
    out: &mut String,
    indent: usize,
    ifc_type: &str,
    row: Option<&EntityRow>,
) {
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
            put_string(out, &mut used, "ifc:GlobalId", g);
        }
        if let Some(n) = &r.name {
            put_string(out, &mut used, "ifc:Name", n);
        }
        if let Some(d) = &r.description {
            put_string(out, &mut used, "ifc:Description", d);
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
pub(super) fn emit_mesh(out: &mut String, indent: usize, name: &str, m: &MeshData) {
    let pad = indent_str(indent);
    let inner = indent_str(indent + 1);

    // Local f32 points + running extent (object space, so the extent is placement-free).
    let mut pts = String::new();
    let mut ext_min = [f32::INFINITY; 3];
    let mut ext_max = [f32::NEG_INFINITY; 3];
    for p in m.positions.chunks_exact(3) {
        for (axis, &v) in p.iter().enumerate() {
            ext_min[axis] = ext_min[axis].min(v);
            ext_max[axis] = ext_max[axis].max(v);
        }
        if !pts.is_empty() {
            pts.push_str(", ");
        }
        write!(pts, "({}, {}, {})", fmt_f32(p[0]), fmt_f32(p[1]), fmt_f32(p[2])).ok();
    }

    // Normals (1:1 with points → vertex interpolation).
    let mut nrm = String::new();
    for n in m.normals.chunks_exact(3) {
        if !nrm.is_empty() {
            nrm.push_str(", ");
        }
        write!(nrm, "({}, {}, {})", fmt_f32(n[0]), fmt_f32(n[1]), fmt_f32(n[2])).ok();
    }

    // faceVertexCounts (all triangles) + indices — built straight into a String,
    // matching the points/normals loops above (no intermediate Vec/per-index String).
    let tri = m.indices.len() / 3;
    let mut counts = String::new();
    for i in 0..tri {
        if i > 0 {
            counts.push_str(", ");
        }
        counts.push('3');
    }
    let mut idx = String::new();
    for i in &m.indices {
        if !idx.is_empty() {
            idx.push_str(", ");
        }
        write!(idx, "{i}").ok();
    }

    let c = clamp_color(m.color);
    let mat = mat_name(color_key(m.color));

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
pub(super) fn emit_material(
    out: &mut String,
    indent: usize,
    key: (i32, i32, i32, i32),
    color: [f32; 4],
) {
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
pub(super) fn write_header(out: &mut String, opts: &UsdOptions) {
    out.push_str("#usda 1.0\n(\n");
    out.push_str("    defaultPrim = \"World\"\n");
    out.push_str("    doc = \"Generated by ifc-lite\"\n");
    out.push_str("    metersPerUnit = 1\n");
    out.push_str("    upAxis = \"Z\"\n");
    out.push_str("    customLayerData = {\n");
    writeln!(out, "        string author = \"{}\"", escape_str(&opts.author)).ok();
    out.push_str("    }\n)\n\n");
}
