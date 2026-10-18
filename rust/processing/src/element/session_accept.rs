// SPDX-License-Identifier: MPL-2.0
//! Once-only canonical presentation after work/owner validation.
use super::presentation_source;
use super::session::ProductState;
use super::session_protocol::{WorkKind, WorkPayload, WorkReply};
use super::session_state::Stage;
use super::session_work::{PartsOutcome, PrimaryOutcome};
use super::*;

impl ProductState {
    pub(super) fn assemble_reply(&mut self, reply: WorkReply, ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder, router: &GeometryRouter) {
        match (reply.request.kind, reply.payload) {
            (WorkKind::TypeMap { map_id, class }, WorkPayload::TypeMap(parts)) => {
                if let Some(parts) = parts {
                    self.meshes.extend(presentation_source::type_parts(&self.job.assembly(), (map_id, class),
                        parts, self.element_color, ctx, decoder, self.presentation_context.as_ref()));
                }
            }
            (WorkKind::Primary { layer_class, .. }, WorkPayload::Primary(outcome)) => {
                self.stage = Stage::Complete;
                match outcome {
                    PrimaryOutcome::RefusedAnnotation => return,
                    PrimaryOutcome::Candidate(submeshes) => {
                        let (meshes, occurrences) = presentation_source::submeshes(&self.job.assembly(), submeshes,
                            self.element_color, ctx, decoder, &mut self.hasher, layer_class,
                            self.presentation_context.as_ref());
                        if !meshes.is_empty() || !occurrences.is_empty() {
                            self.meshes = meshes;
                            self.occurrences = occurrences;
                            return;
                        }
                    }
                    PrimaryOutcome::Retry => {}
                }
                // Retry repeats these cuts. Only CSG records are discarded.
                let _ = router.take_csg_failures();
                self.stage = Stage::VoidedParts;
            }
            (WorkKind::VoidedParts, WorkPayload::VoidedParts(outcome)) => {
                self.stage = Stage::Complete;
                match outcome {
                    PartsOutcome::ConsumedByOpening => {}
                    PartsOutcome::Geometry(parts) => self.assemble_parts(parts, ctx, decoder),
                    PartsOutcome::Retry => self.stage = Stage::PlainParts,
                }
            }
            (WorkKind::PlainParts, WorkPayload::PlainParts(parts)) => {
                self.stage = Stage::Complete;
                self.assemble_parts(parts, ctx, decoder);
            }
            _ => unreachable!("reply variant validated before presentation"),
        }
    }

    fn assemble_parts(&mut self, parts: Vec<Mesh>, ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder) {
        for mesh in parts.into_iter().filter(|mesh| !mesh.is_empty()) {
            self.meshes.extend(presentation_source::fallback(&self.job.assembly(), &self.job.entity, mesh,
                self.element_color, ctx, decoder, &mut self.hasher, self.presentation_context.as_ref()));
        }
    }
}
