// SPDX-License-Identifier: MPL-2.0
//! Synchronous execution of an [`ElementPlan`]: each strategy runs its router
//! work, classifies the coarse outcome, and only then hands the executed parts
//! to presentation. A strategy that produced nothing retries the next one:
//!
//! ```text
//! Primary (voided or textured submeshes)
//!   ├─ Candidate → present; done unless nothing (not even an occurrence) came out
//!   ├─ RefusedAnnotation → terminal, empty (one refused fill counts once)
//!   └─ Retry → VoidedParts
//!                ├─ Geometry → present each non-empty frame part
//!                ├─ ConsumedByOpening → empty is the correct answer
//!                └─ Retry → PlainParts → present each non-empty frame part
//! ```
use super::plan::{ElementPlan, PlanKind, PrimaryStrategy};
use super::*;

/// One type map's executed parts: (mesh, per-vertex UVs, texture).
pub(super) type TypePart = (Mesh, Vec<f32>, Option<ifc_lite_geometry::TextureAttachment>);

enum PrimaryOutcome {
    Candidate(SubMeshCollection),
    Retry,
    RefusedAnnotation,
}

enum PartsOutcome {
    Geometry(Vec<Mesh>),
    ConsumedByOpening,
    Retry,
}

pub(super) fn execute(
    plan: ElementPlan<'_>,
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
    hasher: &mut Option<GeometryHasher>,
) -> (Vec<MeshData>, Vec<RawInstanceOccurrence>) {
    let element_color = plan.element_color;
    let (primary, layer_class) = match plan.kind {
        PlanKind::NoRepresentation => return (Vec::new(), Vec::new()),
        PlanKind::TypeMaps(maps) => {
            let mut meshes = Vec::new();
            // Execute and present one map at a time: each map's colour walk
            // reads source after its own geometry and before the next map's.
            for &(map_id, class) in maps {
                if let Some(parts) = type_map_parts(map_id, ctx, decoder, router) {
                    meshes.extend(emit_type_parts(
                        job,
                        map_id,
                        class,
                        parts,
                        element_color,
                        ctx,
                        decoder,
                    ));
                }
            }
            return (meshes, Vec::new());
        }
        PlanKind::Product {
            primary,
            layer_class,
        } => (primary, layer_class),
    };

    match primary_outcome(primary, job, ctx, decoder, router) {
        PrimaryOutcome::RefusedAnnotation => return (Vec::new(), Vec::new()),
        PrimaryOutcome::Candidate(sub_meshes) => {
            let (meshes, occurrences) =
                emit_sub_meshes(job, sub_meshes, element_color, ctx, decoder, hasher, layer_class);
            // #1623 Phase 2: a pure don't-bake occurrence produces NO flat mesh
            // (only instance placeholders); that is success, so the fallback
            // chain must not re-materialize the element flat.
            if !meshes.is_empty() || !occurrences.is_empty() {
                return (meshes, occurrences);
            }
        }
        PrimaryOutcome::Retry => {}
    }

    // A superseding strategy is about to re-process this element's
    // representation and re-attempt the same (deterministic) cuts; discard the
    // abandoned attempt's diagnostics so re-failures aren't double-counted.
    // The voids→plain retry below intentionally keeps its records: a failed or
    // emptying cut that leaves the host uncut IS the diagnostic.
    let _ = router.take_csg_failures();

    // #6349: frame parts, not one Mesh. A product whose items lie in frames
    // >= 1 km apart keeps each part at full precision; an ordinary one has one.
    let parts = match voided_parts_outcome(job, ctx, decoder, router) {
        PartsOutcome::Geometry(parts) => parts,
        PartsOutcome::ConsumedByOpening => return (Vec::new(), Vec::new()),
        PartsOutcome::Retry => router.process_element_parts(job.entity, decoder).unwrap_or_default(),
    };
    let mut meshes = Vec::new();
    for mesh in parts.into_iter().filter(|mesh| !mesh.is_empty()) {
        meshes.extend(emit_fallback_mesh(job, mesh, element_color, ctx, decoder, hasher));
    }
    (meshes, Vec::new())
}

fn primary_outcome(
    strategy: PrimaryStrategy,
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> PrimaryOutcome {
    let result = match strategy {
        PrimaryStrategy::VoidedSubmeshes => {
            router.process_element_with_submeshes_and_voids(job.entity, decoder, ctx.void_index)
        }
        PrimaryStrategy::TexturedSubmeshes => {
            router.process_element_with_submeshes_textured(job.entity, decoder, ctx.texture_index)
        }
    };
    match result {
        Ok(sub_meshes) if !sub_meshes.is_empty() => PrimaryOutcome::Candidate(sub_meshes),
        // Annotation validation failures are terminal, not another meshing
        // strategy: retrying would count one refused fill three times.
        Err(_)
            if strategy == PrimaryStrategy::TexturedSubmeshes
                && job.ifc_type == IfcType::IfcAnnotation =>
        {
            PrimaryOutcome::RefusedAnnotation
        }
        _ => PrimaryOutcome::Retry,
    }
}

fn voided_parts_outcome(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> PartsOutcome {
    match router.process_element_with_voids_parts(job.entity, decoder, ctx.void_index) {
        Ok(parts) if parts.iter().any(|mesh| !mesh.is_empty()) => PartsOutcome::Geometry(parts),
        // An empty void-cut result normally means the cut FAILED and emptied
        // the host, so it re-renders un-cut. But when a containing void
        // genuinely CONSUMED the host, the empty result is correct; keep it, or
        // the un-cut host re-appears as a spurious solid.
        Ok(_) if router.host_consumed_by_void(job.id) => PartsOutcome::ConsumedByOpening,
        _ => PartsOutcome::Retry,
    }
}

/// Execute one planned RepresentationMap (#957), texture-aware (#961): one part
/// per output mesh, each textured face set with its own UVs and image,
/// untextured items merged into one part. `None` when nothing executed.
fn type_map_parts(
    map_id: u32,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> Option<Vec<TypePart>> {
    let rep_map = decoder.decode_by_id(map_id).ok()?;
    router
        .process_representation_map_with_texture(&rep_map, decoder, ctx.texture_index)
        .ok()
        .filter(|parts| !parts.is_empty())
}
