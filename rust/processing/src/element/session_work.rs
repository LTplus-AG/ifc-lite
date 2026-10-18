// SPDX-License-Identifier: MPL-2.0
//! Reached source/router work. Existing mapping, opening and extension builders
//! remain canonical; their finer command boundaries are not yet exposed.
use super::assembly_types::TypePart;
use super::plan::PrimaryStrategy;
use super::session_state::OwnedJob;
use super::*;
use super::session_protocol::{WorkEmitter, WorkKind, WorkPayload};

pub(super) fn execute(kind: WorkKind, job: &OwnedJob,
    ctx: &MeshProductionContext<'_>, decoder: &mut EntityDecoder,
    router: &GeometryRouter) -> (WorkEmitter, WorkPayload) {
    match kind {
        WorkKind::Primary { strategy: PrimaryStrategy::TexturedSubmeshes, .. } => (
            WorkEmitter::TexturedProduct, WorkPayload::Primary(primary(
                PrimaryStrategy::TexturedSubmeshes, job, ctx, decoder, router))),
        WorkKind::Primary { strategy: PrimaryStrategy::VoidedSubmeshes, .. } => (
            WorkEmitter::VoidedProduct, WorkPayload::Primary(primary(
                PrimaryStrategy::VoidedSubmeshes, job, ctx, decoder, router))),
        WorkKind::TypeMap { map_id, .. } => (WorkEmitter::RepresentationMap,
            WorkPayload::TypeMap(type_map(map_id, ctx, decoder, router))),
        WorkKind::VoidedParts => (WorkEmitter::VoidedParts,
            WorkPayload::VoidedParts(voided_parts(job, ctx, decoder, router))),
        WorkKind::PlainParts => (WorkEmitter::PlainParts, WorkPayload::PlainParts(
            router.process_element_parts(&job.entity, decoder).unwrap_or_default())),
    }
}

pub(super) enum PrimaryOutcome {
    Candidate(SubMeshCollection),
    Retry,
    RefusedAnnotation,
}

pub(super) fn primary(strategy: PrimaryStrategy, job: &OwnedJob,
    ctx: &MeshProductionContext<'_>, decoder: &mut EntityDecoder,
    router: &GeometryRouter) -> PrimaryOutcome {
    let result = match strategy {
        PrimaryStrategy::VoidedSubmeshes => router.process_element_with_submeshes_and_voids(
            &job.entity, decoder, ctx.void_index),
        PrimaryStrategy::TexturedSubmeshes => router.process_element_with_submeshes_textured(
            &job.entity, decoder, ctx.texture_index),
    };
    match result {
        Ok(submeshes) if !submeshes.is_empty() => PrimaryOutcome::Candidate(submeshes),
        Err(_) if matches!(strategy, PrimaryStrategy::TexturedSubmeshes)
            && job.ifc_type == IfcType::IfcAnnotation => PrimaryOutcome::RefusedAnnotation,
        _ => PrimaryOutcome::Retry,
    }
}

pub(super) enum PartsOutcome {
    Geometry(Vec<Mesh>),
    ConsumedByOpening,
    Retry,
}

pub(super) fn voided_parts(job: &OwnedJob, ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder, router: &GeometryRouter) -> PartsOutcome {
    let parts = router.process_element_with_voids_parts(&job.entity, decoder, ctx.void_index).ok();
    match parts {
        Some(parts) if parts.iter().any(|mesh| !mesh.is_empty()) => PartsOutcome::Geometry(parts),
        Some(_) if router.host_consumed_by_void(job.id) => PartsOutcome::ConsumedByOpening,
        _ => PartsOutcome::Retry,
    }
}

pub(super) fn type_map(id: u32, ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder, router: &GeometryRouter) -> Option<Vec<TypePart>> {
    let map = decoder.decode_by_id(id).ok()?;
    let parts = router.process_representation_map_with_texture(&map, decoder, ctx.texture_index).ok()?;
    (!parts.is_empty()).then_some(parts)
}
