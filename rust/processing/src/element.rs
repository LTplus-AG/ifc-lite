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
//! Callers that own their model inputs capture them once into an immutable
//! [`OwnedMeshProductionContext`] snapshot and run this same tree through the
//! synchronous [`produce_element_meshes_owned`] driver (`owned_session`).
//!
//! History: the two pipelines used to carry diverging inline copies of this
//! tree, and fixes had to land twice (#858, #913, #957, #961, #1071). Any
//! change to mesh-production behaviour belongs HERE, exactly once. The only
//! sanctioned behavioural fork is [`TypeGeometryMode`] — a product
//! requirement, not drift: an export must never duplicate type geometry,
//! while the interactive viewer renders it tagged for its Model/Types switch.
//!
//! The converged decision tree (union of the strongest behaviours of both
//! former copies) runs in three phases: `plan` picks the strategy once, one
//! linear product continuation (`session`) issues, executes and accepts one
//! typed ticket per strategy's router work, and late presentation at
//! acceptance turns the executed parts into meshes: `presentation_source`
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
//!    └─ ticket fallback chain when the submesh path produced nothing:
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
mod assembly_job;
use assembly_job::AssemblyJob;
mod presentation;
mod presentation_source;
mod assembly_submeshes;
mod assembly_fallback;
mod assembly_types;
mod model_context;
pub use model_context::{
    OwnedMeshProductionContext, OwnedMeshProductionData, ProductionContextError, ProductionContextId,
    ProductionModel,
};
mod session;
mod session_state;
mod session_protocol;
mod session_owner;
mod session_work;
mod session_accept;
mod session_run;
mod session_canonical;
#[cfg(test)]
mod session_resumable;
mod owned_session;
pub use owned_session::produce_element_meshes_owned;

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
    // One canonical continuation per element (`session`). Its per-element CSG
    // escalation budget (#1109), degenerate tally and pending reports are one
    // owned state, installed for each synchronous slice and restored on
    // return or unwind: a rayon work-steal can run another element to
    // completion inside this one, and a registered processor may produce a
    // nested element on the same decoder and router.
    session_canonical::produce(job, ctx, opts, decoder, router)
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

#[cfg(test)]
mod owned_context_tests;

#[cfg(test)]
mod session_tests;

#[cfg(test)]
mod session_work_tests;

#[cfg(test)]
mod session_canonical_tests;

#[cfg(test)]
mod session_threaded_tests;

#[cfg(test)]
mod session_diagnostic_tests;

#[cfg(test)]
mod session_extension_tests;

#[cfg(test)]
mod owned_reply_tests;

#[cfg(test)]
mod session_stack_tests;

#[cfg(test)]
mod session_unwind_tests;

#[cfg(test)]
mod session_retry_tests;

#[cfg(test)]
mod session_resource_tests;
