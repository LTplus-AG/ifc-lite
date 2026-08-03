// SPDX-License-Identifier: MPL-2.0
//! USD scenegraph instancing (file-size dedup) for the `.usda` exporter.
//!
//! Repeated single-solid mapped geometry that the #1623 don't-bake pipeline turns into
//! `InstanceRecord`s is authored ONCE as a referenced `class Mesh` prototype (pure LOCAL
//! geometry); each occurrence is a `def Mesh` that `references` the prototype and applies a
//! per-occurrence transform + colour. Everything else stays a full mesh, so this can never
//! drop or misplace geometry.
//!
//! This is **file-size dedup**, not composed-stage instancing: without `instanceable = true`
//! the stage still flattens a Mesh per occurrence (per-occurrence colour/metadata are kept —
//! the reason `instanceable` is deliberately not used). Georeferenced ("site-local") models
//! disable don't-bake upstream, so they fall back to the plain full-mesh path automatically.

use std::collections::{HashMap, HashSet};
use std::fmt::Write;

use ifc_lite_processing::{
    process_geometry, process_geometry_streaming_filtered_with_options, InstanceRecord, MeshData,
    OpeningFilterMode, ProcessingResult, StreamingOptions,
};

use super::emit::{write_display_material, write_geometry_body};
use super::fmt::{fmt_f64, indent_str};
use super::mesh_emittable;

/// Prototype prim name for a template `express_id`.
pub(super) fn proto_name(template_express_id: u32) -> String {
    format!("Proto_{template_express_id}")
}

/// Run the geometry pipeline with #1623 don't-bake instancing enabled and collect the
/// result (unbounded batches, default `retain_emitted_meshes` so templates survive).
pub(super) fn run_instanced(content: &[u8]) -> ProcessingResult {
    process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        StreamingOptions {
            initial_batch_size: usize::MAX,
            throughput_batch_size: usize::MAX,
            enable_instancing: true,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

/// Choose the geometry result. Returns `(result, use_instancing)`.
///
/// When instancing is requested we run the don't-bake pass; if it produced instances AND
/// every instance is safe to author (its template passes the mesh gate and its transform is
/// finite + affine), we use it. Otherwise — instances present but any unsafe — we re-run the
/// plain (all-baked) pass so nothing is dropped. The extra pass is rare (only f32-overflow or
/// a template failing the USD mesh gate); the common case is a single pass.
pub(super) fn gather(content: &[u8], instancing: bool) -> (ProcessingResult, bool) {
    if !instancing {
        return (process_geometry(content), false);
    }
    let r = run_instanced(content);
    if r.instances.is_empty() {
        return (r, false); // no repetition — the result is already complete
    }
    if all_instances_safe(&r) {
        (r, true)
    } else {
        (process_geometry(content), false) // rare fallback: re-bake every occurrence
    }
}

/// Every instance must reference a template that passes the USD mesh gate and carry a
/// finite, affine transform — otherwise authoring it would strand or misplace geometry.
fn all_instances_safe(r: &ProcessingResult) -> bool {
    let ok_templates: HashSet<u32> =
        r.meshes.iter().filter(|m| mesh_emittable(m)).map(|m| m.express_id).collect();
    r.instances.iter().all(|rec| {
        ok_templates.contains(&rec.template_express_id) && transform_is_affine_finite(&rec.transform)
    })
}

/// True when `a` is finite and affine (bottom row ≈ (0,0,0,1)). A projective row would make
/// the authored `matrix4d` misplace geometry (the reconstruction divides by w).
fn transform_is_affine_finite(a: &[f32; 16]) -> bool {
    a.iter().all(|v| v.is_finite())
        && a[12].abs() < 1e-6
        && a[13].abs() < 1e-6
        && a[14].abs() < 1e-6
        && (a[15] - 1.0).abs() < 1e-6
}

/// The occurrence's object-LOCAL → WORLD transform, authored as a USD `matrix4d` (4 rows).
///
/// `InstanceRecord.transform` `A` is column-vector, row-major, template-relative:
/// `occ_world = A · (template.origin + P)` for local point `P`. So the local→world map is
/// `M = A · T(origin)`, and USD (row-vector; translation in the last ROW) authors `M`ᵀ. All
/// arithmetic is f64 (`A` widened, `origin` already f64); `A`'s translation is in the
/// post-RTC frame so its f32 storage stays sub-mm even at national-grid extents.
/// Returns `None` for a non-finite / non-affine `A` (callers must have gated via
/// [`all_instances_safe`], so `None` never reaches emission on the instanced path).
pub(super) fn usd_transform_rows(a: &[f32; 16], origin: [f64; 3]) -> Option<[[f64; 4]; 4]> {
    if !transform_is_affine_finite(a) {
        return None;
    }
    let at = |r: usize, c: usize| a[r * 4 + c] as f64;
    // Translation of M = A · T(origin): tᵢ = Aᵢ₀·oₓ + Aᵢ₁·o_y + Aᵢ₂·o_z + Aᵢ₃.
    let t = |i: usize| at(i, 0) * origin[0] + at(i, 1) * origin[1] + at(i, 2) * origin[2] + at(i, 3);
    // USD rows are the COLUMNS of M (transpose): linear 3×3 = A's, translation in row 3.
    Some([
        [at(0, 0), at(1, 0), at(2, 0), 0.0],
        [at(0, 1), at(1, 1), at(2, 1), 0.0],
        [at(0, 2), at(1, 2), at(2, 2), 0.0],
        [t(0), t(1), t(2), 1.0],
    ])
}

/// Emit a `class Mesh` prototype: pure LOCAL geometry, no placement, no material (occurrences
/// bind their own). `class` (abstract) so it is only referenced, never rendered directly.
pub(super) fn emit_prototype(out: &mut String, indent: usize, name: &str, m: &MeshData) {
    let pad = indent_str(indent);
    writeln!(out, "\n{pad}class Mesh \"{name}\"").ok();
    writeln!(out, "{pad}{{").ok();
    write_geometry_body(out, indent, m);
    writeln!(out, "{pad}}}").ok();
}

/// Emit an instance occurrence's geometry: a `def Mesh` that references its prototype and
/// applies the per-occurrence transform, colour and (optional) purpose.
pub(super) fn emit_instance_occurrence(
    out: &mut String,
    indent: usize,
    name: &str,
    rec: &InstanceRecord,
    template_origin: &HashMap<u32, [f64; 3]>,
    purpose: Option<&str>,
) {
    let origin = template_origin.get(&rec.template_express_id).copied().unwrap_or([0.0; 3]);
    // Gated by `all_instances_safe` before we ever reach the instanced path.
    let Some(rows) = usd_transform_rows(&rec.transform, origin) else {
        return;
    };
    let pad = indent_str(indent);
    let inner = indent_str(indent + 1);
    let proto = proto_name(rec.template_express_id);

    writeln!(out, "\n{pad}def Mesh \"{name}\" (").ok();
    writeln!(out, "{inner}prepend references = </World/Prototypes/{proto}>").ok();
    writeln!(out, "{inner}prepend apiSchemas = [\"MaterialBindingAPI\"]").ok();
    writeln!(out, "{pad})").ok();
    writeln!(out, "{pad}{{").ok();
    writeln!(
        out,
        "{inner}matrix4d xformOp:transform = ( ({}, {}, {}, {}), ({}, {}, {}, {}), \
         ({}, {}, {}, {}), ({}, {}, {}, {}) )",
        fmt_f64(rows[0][0]), fmt_f64(rows[0][1]), fmt_f64(rows[0][2]), fmt_f64(rows[0][3]),
        fmt_f64(rows[1][0]), fmt_f64(rows[1][1]), fmt_f64(rows[1][2]), fmt_f64(rows[1][3]),
        fmt_f64(rows[2][0]), fmt_f64(rows[2][1]), fmt_f64(rows[2][2]), fmt_f64(rows[2][3]),
        fmt_f64(rows[3][0]), fmt_f64(rows[3][1]), fmt_f64(rows[3][2]), fmt_f64(rows[3][3]),
    )
    .ok();
    writeln!(out, "{inner}uniform token[] xformOpOrder = [\"xformOp:transform\"]").ok();
    if let Some(p) = purpose {
        writeln!(out, "{inner}uniform token purpose = \"{p}\"").ok();
    }
    write_display_material(out, indent, rec.color);
    writeln!(out, "{pad}}}").ok();
}
