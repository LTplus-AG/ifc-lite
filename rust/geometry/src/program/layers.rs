// SPDX-License-Identifier: MPL-2.0
//! One material-layer attempt: eligibility, the canonical merged void-program
//! host, the late placement frame, then the interface planes, the slice and
//! its cleanup as numerical steps. Diagnostics publish at accept, in order.
//!
//! The attempt reaches its host only after eligibility admitted it, and its
//! frame only after the host was accepted non-empty, so a host callback that
//! updates the decoder is observed rather than a stale read. A resource stop
//! reached by any step ends the attempt with the stop; it is never recorded
//! as a layer skip.
use super::inner::{ProgramError, ProgramStage};
use super::product::ProductOutput;
use super::voids::{VoidControl, VoidReply};
use crate::material_layer_index::LayerBuildup;
use crate::router::frame_parts::single_frame;
use crate::router::layers::{
    LayerPlaneRequest, LayerProgram, LayerSkip, LayerSliceResult, ReadyLayerPlanes, ReadyLayerSlice,
};
use crate::{Error, GeometryRouter, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Where the attempt's buildup comes from, and what a decline means.
#[derive(Clone, Copy)]
enum Mode<'a> {
    /// The router's material-layer index; a failed host or fewer than two
    /// slices keep the single solid, and kept slices are cleaned.
    Index,
    /// An explicit buildup: a failed host is the attempt's error and the
    /// published slices are returned as they are.
    Buildup(&'a LayerBuildup),
}

enum State<'a> {
    Eligibility,
    Host(LayerProgram, VoidControl<'a>),
    Frame(LayerPlaneRequest),
    Planes(ReadyLayerPlanes),
    Slice(ReadyLayerSlice),
    Clean(SubMeshCollection),
    Complete(Result<Option<SubMeshCollection>>),
    /// Moved out by an executing or accepting step.
    Taken,
}

/// `None` when the element has no sliceable buildup at all.
type Admitted = Option<std::result::Result<Option<LayerProgram>, LayerSkip>>;

pub(super) enum LayerReply {
    Eligible(Admitted),
    Host(VoidReply),
    Frame(std::result::Result<ReadyLayerPlanes, LayerSkip>),
    Planes(std::result::Result<ReadyLayerSlice, LayerSkip>),
    Sliced(LayerSliceResult),
    Cleaned(SubMeshCollection),
}

impl LayerReply {
    pub(super) fn tag(&self) -> u8 {
        match self {
            Self::Host(reply) => reply.tag(),
            Self::Eligible(_) => 100,
            Self::Frame(_) => 101,
            Self::Planes(_) => 102,
            Self::Sliced(_) => 103,
            Self::Cleaned(_) => 104,
        }
    }
}

pub(super) struct LayerControl<'a> {
    element: &'a DecodedEntity,
    /// The openings the host is cut by; empty for the uncut host.
    ids: &'a [u32],
    mode: Mode<'a>,
    state: State<'a>,
}

impl<'a> LayerControl<'a> {
    /// The gateway attempt through the router's material-layer index.
    pub(super) fn index(element: &'a DecodedEntity, ids: &'a [u32]) -> Self {
        Self { element, ids, mode: Mode::Index, state: State::Eligibility }
    }

    /// An attempt with an explicit `buildup`.
    pub(super) fn buildup(element: &'a DecodedEntity, buildup: &'a LayerBuildup, ids: &'a [u32]) -> Self {
        Self { element, ids, mode: Mode::Buildup(buildup), state: State::Eligibility }
    }

    pub(super) fn stage(&self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        Ok(match &self.state {
            State::Eligibility | State::Frame(_) => Some(ProgramStage::Source),
            State::Host(_, host) => return host.stage(),
            State::Planes(_) | State::Slice(_) | State::Clean(_) => Some(ProgramStage::Numerical),
            State::Complete(_) => None,
            State::Taken => return Err(ProgramError::Outstanding),
        })
    }

    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<LayerReply, ProgramError> {
        let element = self.element;
        match &mut self.state {
            State::Eligibility => return Ok(LayerReply::Eligible(self.admit(router, decoder))),
            State::Host(_, host) => return host.execute(router, decoder).map(LayerReply::Host),
            _ => {}
        }
        Ok(match std::mem::replace(&mut self.state, State::Taken) {
            State::Frame(request) => LayerReply::Frame(request.admit_frame(element, decoder, router)),
            State::Planes(ready) => LayerReply::Planes(ready.execute()),
            State::Slice(ready) => LayerReply::Sliced(ready.execute()),
            State::Clean(mut collection) => {
                // Slicing by layer-interface planes can introduce zero-area or
                // collinear slivers at the cut; the gateway cleans its slices.
                for sub in &mut collection.sub_meshes {
                    sub.mesh.clean_degenerate();
                }
                LayerReply::Cleaned(collection)
            }
            other => {
                self.state = other;
                return Err(ProgramError::StaleRequest);
            }
        })
    }

    pub(super) fn accept(&mut self, reply: LayerReply, router: &GeometryRouter) {
        let state = std::mem::replace(&mut self.state, State::Taken);
        // A stop reached by a layer step ends the attempt with the stop; the
        // host child checks its own.
        if !matches!(reply, LayerReply::Host(_)) && self.stopped() {
            return;
        }
        self.state = match (state, reply) {
            (State::Eligibility, LayerReply::Eligible(admitted)) => self.admitted(admitted, router),
            (State::Host(program, mut host), LayerReply::Host(reply)) => {
                host.accept(reply, router);
                match host.take_result() {
                    None => State::Host(program, host),
                    Some(result) => self.host_complete(program, result, router),
                }
            }
            (State::Taken, LayerReply::Frame(result)) => match result {
                Ok(ready) => State::Planes(ready),
                Err(skip) => self.skip(skip, router),
            },
            (State::Taken, LayerReply::Planes(result)) => match result {
                Ok(ready) => State::Slice(ready),
                Err(skip) => self.skip(skip, router),
            },
            (State::Taken, LayerReply::Sliced(result)) => self.sliced(result.publish(router, self.element.id)),
            (State::Taken, LayerReply::Cleaned(collection)) => State::Complete(Ok(Some(collection))),
            // Payload validation precedes acceptance; a mismatch cannot reach here.
            (state, _) => state,
        };
    }

    /// Run the attempt to completion against one router and decoder: the
    /// synchronous driver. Eligibility and the host walk run in place, each
    /// as the one step `execute` and `accept` take, so neither crosses a
    /// reply the size of the host walk's; the rare slicing steps take the
    /// protocol's own path.
    pub(super) fn run(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<(), ProgramError> {
        loop {
            if matches!(self.state, State::Eligibility) {
                let admitted = self.admit(router, decoder);
                if !self.stopped() {
                    self.state = self.admitted(admitted, router);
                }
            } else if let State::Host(_, host) = &mut self.state {
                host.run(router, decoder)?;
                let result = host.take_result().ok_or(ProgramError::Outstanding)?;
                let State::Host(program, _) = std::mem::replace(&mut self.state, State::Taken) else {
                    return Err(ProgramError::StaleRequest);
                };
                self.state = self.host_complete(program, result, router);
            } else if self.stage()?.is_some() {
                let reply = self.execute(router, decoder)?;
                self.accept(reply, router);
            } else {
                return Ok(());
            }
        }
    }

    /// Whether the buildup is sliceable at all, and if so its admission.
    fn admit(&self, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Admitted {
        let element = self.element;
        let buildup = match self.mode {
            Mode::Buildup(buildup) => Some(buildup),
            Mode::Index => router
                .material_layer_index()
                .and_then(|index| index.get(element.id))
                .filter(|buildup| buildup.is_sliceable()),
        };
        buildup.map(|buildup| LayerProgram::admit(element, decoder, buildup, router.unit_scale()))
    }

    fn admitted(&self, admitted: Admitted, router: &GeometryRouter) -> State<'a> {
        match admitted {
            Some(Ok(Some(program))) => State::Host(program, VoidControl::merged(self.element, self.ids)),
            Some(Err(skip)) => self.skip(skip, router),
            None | Some(Ok(None)) => State::Complete(Ok(None)),
        }
    }

    /// A resource stop ends the attempt with the stop.
    fn stopped(&mut self) -> bool {
        match crate::resource::check_current() {
            Ok(()) => false,
            Err(stop) => {
                self.state = State::Complete(Err(stop.into()));
                true
            }
        }
    }

    pub(super) fn take_result(&mut self) -> Option<Result<Option<SubMeshCollection>>> {
        match std::mem::replace(&mut self.state, State::Taken) {
            State::Complete(result) => Some(result),
            other => {
                self.state = other;
                None
            }
        }
    }

    /// The host is complete: one frame, non-empty, or the attempt declines.
    fn host_complete(&self, program: LayerProgram, host: Result<ProductOutput>, router: &GeometryRouter) -> State<'a> {
        let host = host.and_then(|host| match host {
            ProductOutput::Parts(parts) => single_frame(self.element.id, parts),
            ProductOutput::Styled(_) => Err(Error::geometry("layer host completed as sub-meshes")),
        });
        let host = match (host, self.mode) {
            (Ok(host), _) => host,
            (Err(stop @ Error::ProgramStopped(_)), _) | (Err(stop), Mode::Buildup(_)) => {
                return State::Complete(Err(stop))
            }
            (Err(_), Mode::Index) => {
                // A sliceable element whose host build errored keeps a single
                // solid. Record for the browser; warn for native.
                router.push_layer_slice_diag(self.element.id, "skip:base-mesh-error");
                crate::diag::diag_warn!(
                    { element_id = self.element.id, reason = "base-mesh-error",
                      "material-layers: sliceable element failed to slice, keeping single solid" }
                    else {
                        eprintln!("[material-layers] #{}: sliceable but slicing errored", self.element.id);
                    }
                );
                return State::Complete(Ok(None));
            }
        };
        match program.accept_host(host) {
            Ok(request) => State::Frame(request),
            Err(skip) => self.skip(skip, router),
        }
    }

    fn sliced(&self, collection: SubMeshCollection) -> State<'a> {
        let id = self.element.id;
        let count = collection.sub_meshes.len();
        if matches!(self.mode, Mode::Buildup(_)) {
            return State::Complete(Ok(Some(collection)));
        }
        if count < 2 {
            crate::diag::diag_warn!(
                { element_id = id, sub_meshes = count, reason = "fewer-than-two-sub-meshes",
                  "material-layers: sliceable element produced too few sub-meshes, keeping single solid" }
                else {
                    eprintln!(
                        "[material-layers] #{id}: sliceable but produced {count} sub-mesh(es) (<2) — keeping single solid"
                    );
                }
            );
            return State::Complete(Ok(None));
        }
        crate::diag::diag_debug!(
            { element_id = id, sub_meshes = count, "material-layers: sliced element into layer sub-meshes" }
            else {
                eprintln!("[material-layers] #{id}: sliced into {count} layer sub-meshes");
            }
        );
        State::Clean(collection)
    }

    fn skip(&self, skip: LayerSkip, router: &GeometryRouter) -> State<'a> {
        router.push_layer_slice_diag(self.element.id, skip.reason());
        State::Complete(Ok(None))
    }
}

#[cfg(test)]
#[path = "layers_tests.rs"]
mod tests;
