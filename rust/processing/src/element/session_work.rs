// SPDX-License-Identifier: MPL-2.0
//! Reached source/router work for one ticket: each strategy runs its router
//! work and classifies the coarse outcome; presentation happens only at
//! acceptance. A strategy that produced nothing retries the next one:
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
//!
//! The router's mapping, opening and extension builders stay canonical; their
//! finer command boundaries are not exposed through this protocol.
use super::assembly_types::TypePart;
use super::plan::PrimaryStrategy;
use super::session_protocol::{WorkKind, WorkPayload};
use super::*;

pub(super) enum PrimaryOutcome {
    Candidate(SubMeshCollection),
    Retry,
    RefusedAnnotation,
}

pub(super) enum PartsOutcome {
    Geometry(Vec<Mesh>),
    ConsumedByOpening,
    Retry,
}

pub(super) fn execute(
    kind: WorkKind,
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> WorkPayload {
    if let Err(stop) = ifc_lite_geometry::resource::check_current() {
        return stopped(stop);
    }
    let payload = match kind {
        WorkKind::Primary { strategy, .. } => WorkPayload::Primary(primary(strategy, job, ctx, decoder, router)),
        WorkKind::TypeMap { map_id, .. } => WorkPayload::TypeMap(type_map(map_id, ctx, decoder, router)),
        WorkKind::VoidedParts => WorkPayload::VoidedParts(voided_parts(job, ctx, decoder, router)),
        WorkKind::PlainParts => {
            WorkPayload::PlainParts(router.process_element_parts(job.entity, decoder).unwrap_or_default())
        }
    };
    // A stop reached inside the router outranks the geometry it returned.
    match ifc_lite_geometry::resource::check_current() {
        Ok(()) => payload,
        Err(stop) => stopped(stop),
    }
}

#[cold]
#[inline(never)]
fn stopped(stop: ifc_lite_geometry::resource::ProgramStop) -> WorkPayload {
    WorkPayload::Stopped(stop)
}

fn primary(
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
        Err(_) if strategy == PrimaryStrategy::TexturedSubmeshes && job.ifc_type == IfcType::IfcAnnotation => {
            PrimaryOutcome::RefusedAnnotation
        }
        _ => PrimaryOutcome::Retry,
    }
}

fn voided_parts(
    job: &ElementMeshJob<'_>,
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> PartsOutcome {
    // A superseding strategy is about to re-process this element's
    // representation and re-attempt the same (deterministic) cuts; discard
    // the abandoned attempt's diagnostics so re-failures aren't
    // double-counted. The voids→plain retry keeps its records: a failed or
    // emptying cut that leaves the host uncut IS the diagnostic. The drain
    // runs every processor's hook, so it belongs inside the owner epoch.
    let _ = router.take_csg_failures();
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
fn type_map(
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
