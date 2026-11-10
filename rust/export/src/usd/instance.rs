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

use std::collections::HashMap;
use std::fmt::Write;

use ifc_lite_processing::{InstanceRecord, MeshData};

use super::emit::{write_display_material, write_geometry_body};
use super::fmt::{fmt_matrix4d, indent_str};
use crate::scene_input::transform_is_affine_finite;

/// Prototype prim name for a template `express_id`.
pub(super) fn proto_name(template_express_id: u32) -> String {
    format!("Proto_{template_express_id}")
}

/// The occurrence's object-LOCAL → WORLD transform, authored as a USD `matrix4d` (4 rows).
///
/// `InstanceRecord.transform` `A` is column-vector, row-major, template-relative:
/// `occ_world = A · (template.origin + P)` for local point `P`. So the local→world map is
/// `M = A · T(origin)`, and USD (row-vector; translation in the last ROW) authors `M`ᵀ. All
/// arithmetic is f64 (`A` widened, `origin` already f64); `A`'s translation is in the
/// post-RTC frame so its f32 storage stays sub-mm even at national-grid extents.
/// Returns `None` for a non-finite / non-affine `A` (callers must have gated via
/// `scene_input::gather`'s safety gate, so `None` never reaches emission on the instanced path).
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
    writeln!(out, "{inner}matrix4d xformOp:transform = {}", fmt_matrix4d(&rows)).ok();
    writeln!(out, "{inner}uniform token[] xformOpOrder = [\"xformOp:transform\"]").ok();
    if let Some(p) = purpose {
        writeln!(out, "{inner}uniform token purpose = \"{p}\"").ok();
    }
    write_display_material(out, indent, rec.color);
    writeln!(out, "{pad}}}").ok();
}
