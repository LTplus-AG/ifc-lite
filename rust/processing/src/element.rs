// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical per-element mesh production — THE single decision tree that turns
//! one IFC product (or type-product RepresentationMap) into renderable meshes.
//!
//! Both pipelines run this exact code:
//! - the native orchestrator (`processor.rs`) calls [`produce_element_meshes`]
//!   from its rayon loop with a fresh seeded decoder + router per element;
//! - the browser batch path (`wasm-bindings` `processGeometryBatch`) calls it
//!   per job with a warm per-batch decoder + router.
//!
//! History: the two pipelines used to carry diverging inline copies of this
//! tree, and fixes had to land twice (#858, #913, #957, #961, #1071). Any
//! change to mesh-production behaviour belongs HERE, exactly once. The only
//! sanctioned behavioural fork is [`TypeGeometryMode`] — a product
//! requirement, not drift: an export must never duplicate type geometry,
//! while the interactive viewer renders it tagged for its Model/Types switch.
//!
//! The converged decision tree (union of the strongest behaviours of both
//! former copies) runs in three phases: `plan` picks the strategy once,
//! `execution` runs and classifies each strategy's router work, and late
//! presentation turns the executed parts into meshes: `presentation_source`
//! resolves every source-dependent field (colour, material name, palette
//! selection) into a source-free `presentation::ReadyBody`, and the
//! decoder-free `assembly_*` modules apply UV/texture, the palette split,
//! metadata and geometry_class through one body funnel.
//!
//! ```text
//! plan: representation gate (IfcAlignment exempt)
//! ├─ TypeProduct job (#957): render each planned RepresentationMap
//! │    (textures #961, geometry_class tag, styled-item colour)
//! └─ Product job:
//!    ├─ has openings → submesh-aware void cut (per-part colours survive)
//!    ├─ else        → submesh path for ALL types (per-item colours,
//!    │                per-item error skipping, #858 palette split per item)
//!    └─ execution fallback chain when the submesh path produced nothing:
//!         void-aware single mesh → plain element → element-level #858 split
//!         → single coloured mesh
//! ```

use crate::style::{FullIndexedColourMap, GeometryStyleInfo};
use crate::types::mesh::{MeshData, MeshTextureData, RawInstanceOccurrence};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::{
    calculate_normals, orient_mesh_outward_verdict, BoolFailure,
    GeometryHasher, GeometryRouter, Mesh, ResolvedTextureMap, SubMeshCollection,
};
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeMap;

/// The f32-collapse degenerate backstop, its per-element tally, and the reason
/// that tally now gates the closure verdict. A CHILD module: it exists only to
/// serve this file's produce/emit cycle.
#[path = "element_degenerate.rs"]
mod degenerate;
#[path = "element_scopes.rs"]
mod element_scopes;
mod element_color;
use element_color::{find_indexed_colour_for_element, infer_opening_subpart_material_name};
// Re-exported because they have callers outside this module: the colour
// resolvers from processor/, the style-source walks from style::finish_join.
pub(crate) use element_color::{find_geometry_item_color, resolve_color_for_representation_map};
pub(crate) use element_color::{find_geometry_item_style_source, product_shape_style_source, representation_map_style_source};

mod types;
pub use types::*;
mod plan;
pub use plan::plan_type_geometry;
mod execution;
mod assembly_job;
use assembly_job::AssemblyJob;
mod presentation;
mod presentation_source;
mod assembly_submeshes;
mod assembly_fallback;
mod assembly_types;

/// THE canonical per-element mesh producer.
///
/// Decoder and router are caller-supplied so each pipeline keeps its reuse
/// policy: the native rayon loop builds a fresh seeded decoder + router per
/// element; the browser batch path reuses one warm pair per batch. The
/// decoder MUST have its unit-scale caches seeded
/// (`EntityDecoder::seed_unit_scales`) — otherwise arc tessellation re-pays
/// an O(file) IFCPROJECT scan per fresh decoder.
pub fn produce_element_meshes(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> ProducedElementMeshes {
    // Open a per-element CSG escalation scope (#1109). Every boolean this element
    // issues (one per opening, plus clip cuts) accumulates into ONE deterministic
    // budget, so a boolean-heavy element (a slab cut by 24+ openings, a Tekla
    // member with stacked half-space clips) degrades as a UNIT — its remaining
    // cuts bail to the #635 AABB fallback — instead of grinding the geometry
    // stream past the 95% watchdog. The per-boolean cap alone could not see this
    // distributed cost. Unbounded under the server/offline-export profile.
    // The element's budget, degenerate tally and pending reports are one owned
    // state, installed for this synchronous call and restored on return or
    // unwind: a rayon work-steal can run another element to completion inside
    // this one.
    element_scopes::ElementScopes::new()
        .with_scope(|| produce_in_scope(job, ctx, opts, decoder, router))
}

fn produce_in_scope(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> ProducedElementMeshes {
    ifc_lite_geometry::progress::tick();

    let mut hasher = match (&job.kind, opts.geometry_hash) {
        (ElementJobKind::Product, Some(cfg)) => {
            Some(GeometryHasher::new(cfg.tolerance, cfg.world_rtc))
        }
        _ => None,
    };

    // #858 splits a colour-mapped face set by triangle index, so its triangles
    // must keep their order through source hygiene (#5313).
    let keep_order = !ctx.indexed_colour_full.is_empty()
        && element_color::element_reaches_indexed_colour(job.entity, ctx.indexed_colour_full, decoder);
    let previous_order = router.set_preserve_triangle_order(keep_order);
    let plan = plan::plan_element(job, ctx, decoder, router);
    let (mut meshes, mut instance_occurrences) =
        execution::execute(plan, job, ctx, decoder, router, &mut hasher);
    router.set_preserve_triangle_order(previous_order);

    // A class with a fixed display colour (openings, #5409) overrides whatever
    // colour the style precedence resolved, on every mesh AND every don't-bake
    // occurrence, so no path (sub-mesh, palette split, fallback) can leak one.
    if let Some(fixed) = crate::style::fixed_display_color_for_type(&job.ifc_type) {
        let fixed = fixed.to_array();
        for mesh in &mut meshes {
            mesh.color = fixed;
            mesh.texture = None;
            mesh.uvs = None;
        }
        for occurrence in &mut instance_occurrences {
            occurrence.color = fixed;
        }
    }

    // Drain the router's per-element CSG diagnostics on EVERY return path so
    // a warm (batch-reused) router starts the next element clean.
    let csg_failures = router.take_csg_failures();

    // A hash with NO box is reachable and deliberately KEPT (a NaN axis hashes
    // but never accumulates); `push_geometry_hash` reserves NaN slots so the FFI
    // arrays still cannot misalign. Box-without-hash is impossible. VOLUME may
    // likewise be `None` within an emitted entry (landing as NaN) — the normal
    // answer for most elements. See `world_aabb` / `GeometryHasher::volume`.
    let degenerate_triangles_dropped = degenerate::dropped_this_element();

    // The verdict was taken where the orienter runs; `build_mesh_data` then ran
    // the degenerate backstop over the same triangles, and a dropped triangle
    // opens every neighbour along its three edges. Retract before reading, so
    // what ships describes the mesh actually returned (see
    // `retract_closure_if_mesh_edited`).
    let (geometry_hash, geometry_aabb, geometry_volume, geometry_closure) = match hasher {
        Some(mut h) if !h.is_empty() => {
            h.retract_closure_if_mesh_edited(degenerate_triangles_dropped);
            (Some(h.finish()), h.world_aabb(), h.volume(), Some(h.closure()))
        }
        _ => (None, None, None, None),
    };

    ProducedElementMeshes {
        meshes,
        instance_occurrences,
        geometry_hash,
        geometry_aabb,
        geometry_volume,
        geometry_closure,
        csg_failures,
        degenerate_triangles_dropped,
    }
}

/// geometry_class for the per-layer slices of a material-layer wall. The wall's
/// slices have verified outward winding, so the 3D renderer draws THIS class
/// BACKFACE-CULLED — the build-up shows on the faces/edges but the interior
/// coincident caps never rasterise, so the thin stacked solids don't z-fight
/// into a hollow shell. The 2D/section cut consumes the same class (never
/// culled) for its per-layer fills.
pub const GEOM_CLASS_LAYER_SLICE: u8 = 3;

#[path = "element_mesh_build.rs"]
mod element_mesh_build;
use element_mesh_build::build_mesh_data;

#[cfg(test)]
#[path = "element_tests.rs"]
mod tests;

#[cfg(test)]
mod phase_tests;

#[cfg(test)]
mod presentation_tests;

#[cfg(test)]
mod presentation_palette_tests;
