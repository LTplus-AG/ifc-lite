// SPDX-License-Identifier: MPL-2.0
//! Once-only canonical presentation after work/owner validation, and the
//! strategy transitions each coarse outcome selects.
use super::presentation_source;
use super::session::ProductState;
use super::session_protocol::{WorkKind, WorkPayload, WorkReply};
use super::session_state::Stage;
use super::session_work::{PartsOutcome, PrimaryOutcome};
use super::*;

impl ProductState<'_> {
    pub(super) fn assemble_reply(
        &mut self,
        reply: WorkReply,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
    ) {
        let assembly = AssemblyJob::from(self.job);
        match (reply.request.kind, reply.payload) {
            (_, WorkPayload::Stopped(stop)) => self.remember_stop(stop),
            // Execute and present one map at a time: each map's colour walk
            // reads source after its own geometry and before the next map's.
            // A map that executed nothing presents nothing.
            (WorkKind::TypeMap { map_id, class }, WorkPayload::TypeMap(Some(parts))) => {
                self.meshes.extend(presentation_source::type_parts(
                    &assembly,
                    (map_id, class),
                    parts,
                    self.element_color,
                    ctx,
                    decoder,
                ));
            }
            (WorkKind::Primary { layer_class, .. }, WorkPayload::Primary(outcome)) => {
                self.stage = Stage::Complete;
                match outcome {
                    PrimaryOutcome::RefusedAnnotation => return,
                    PrimaryOutcome::Candidate(sub_meshes) => {
                        let (meshes, occurrences) = presentation_source::submeshes(
                            &assembly,
                            sub_meshes,
                            self.element_color,
                            ctx,
                            decoder,
                            &mut self.hasher,
                            layer_class,
                        );
                        // #1623 Phase 2: a pure don't-bake occurrence produces
                        // NO flat mesh (only instance placeholders); that is
                        // success, so the fallback chain must not re-materialize
                        // the element flat.
                        if !meshes.is_empty() || !occurrences.is_empty() {
                            self.meshes = meshes;
                            self.occurrences = occurrences;
                            return;
                        }
                    }
                    PrimaryOutcome::Retry => {}
                }
                // The superseding voids strategy discards the abandoned
                // attempt's diagnostics when it executes (`session_work`),
                // inside the owner epoch, so a processor's drain hook keeps
                // its lexical child access.
                self.stage = Stage::VoidedParts;
            }
            (WorkKind::VoidedParts, WorkPayload::VoidedParts(outcome)) => {
                self.stage = Stage::Complete;
                match outcome {
                    PartsOutcome::ConsumedByOpening => {}
                    PartsOutcome::Geometry(parts) => self.assemble_parts(&assembly, parts, ctx, decoder),
                    PartsOutcome::Retry => self.stage = Stage::PlainParts,
                }
            }
            (WorkKind::PlainParts, WorkPayload::PlainParts(parts)) => {
                self.stage = Stage::Complete;
                self.assemble_parts(&assembly, parts, ctx, decoder);
            }
            // `before_accept` refused every other pairing.
            _ => {}
        }
    }

    /// #6349: frame parts, not one Mesh. A product whose items lie in frames
    /// >= 1 km apart keeps each part at full precision; an ordinary one has one.
    fn assemble_parts(
        &mut self,
        assembly: &AssemblyJob<'_>,
        parts: Vec<Mesh>,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
    ) {
        for mesh in parts.into_iter().filter(|mesh| !mesh.is_empty()) {
            self.meshes.extend(presentation_source::fallback(
                assembly,
                self.job.entity,
                mesh,
                self.element_color,
                ctx,
                decoder,
                &mut self.hasher,
            ));
        }
    }
}
