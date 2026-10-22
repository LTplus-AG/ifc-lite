// SPDX-License-Identifier: MPL-2.0
//! One host's void context: classify every requested opening, merge the
//! rectangles, then capture the parametric and planar fast-path data. Each
//! stage is a child control over the same lent host and ids; a gate is read
//! only when its stage is reached.
use super::classify::Classifier;
use super::requests::{OpeningReady, OpeningReply, OpeningSource};
use super::{planar, protocol, rectangular, OpeningOutput, OpeningPoll};
use crate::program::opening::OpeningChild;
use crate::router::voids::bool2d_path::{self, Bool2dCut};
use crate::router::voids::{OpeningType, ParamRectCut, VoidContext};
use crate::{GeometryRouter, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

pub(crate) struct HostOpenings<'a> {
    host: &'a DecodedEntity,
    ids: &'a [u32],
    stage: Stage<'a>,
    openings: Vec<OpeningType>,
    merged_openings: Vec<OpeningType>,
    param: Option<ParamRectCut>,
    next: Option<OpeningPoll>,
}

enum Stage<'a> {
    Classify(Classifier<'a>),
    Rectangle(rectangular::Capture<'a>),
    Planar(planar::Capture<'a>),
    Waiting,
    Complete,
}

impl<'a> HostOpenings<'a> {
    pub(super) fn new(host: &'a DecodedEntity, ids: &'a [u32]) -> Self {
        Self {
            host,
            ids,
            stage: Stage::Classify(Classifier::new(host, ids, true)),
            openings: Vec::new(),
            merged_openings: Vec::new(),
            param: None,
            next: None,
        }
    }

    pub(super) fn poll(&mut self) -> OpeningPoll {
        loop {
            if let Some(next) = self.next.take() {
                return next;
            }
            let poll = match &mut self.stage {
                Stage::Classify(stage) => stage.poll(),
                Stage::Rectangle(stage) => stage.poll(),
                Stage::Planar(stage) => stage.poll(),
                Stage::Waiting => return self.fail(protocol("host openings reply pending")),
                Stage::Complete => return self.fail(protocol("host openings already complete")),
            };
            let OpeningPoll::Complete(output) = poll else {
                return poll;
            };
            if let Err(error) = self.stage_complete(output) {
                return self.fail(error);
            }
        }
    }

    fn fail(&mut self, error: crate::Error) -> OpeningPoll {
        self.stage = Stage::Complete;
        OpeningPoll::Complete(Err(error))
    }

    fn stage_complete(&mut self, output: Result<OpeningOutput>) -> Result<()> {
        let stage = std::mem::replace(&mut self.stage, Stage::Waiting);
        match (stage, output?) {
            (Stage::Classify(_), OpeningOutput::Classified(openings)) => {
                self.next = Some(OpeningPoll::Ready(OpeningReady::Merge(openings)));
            }
            (Stage::Rectangle(_), OpeningOutput::Rectangle(param)) => {
                self.param = param;
                self.planar();
            }
            (Stage::Planar(_), OpeningOutput::Planar(cut)) => self.finish(cut),
            _ => return Err(protocol("host openings stage output")),
        }
        Ok(())
    }

    /// PARAMETRIC capture (flag-gated, zero cost when off): probe the host and
    /// every opening for an exact rectangular box, reconcile each opening's
    /// boxes against its mesh, and require all to share the host frame.
    fn rectangle(&mut self) {
        if crate::rect_fast::param_enabled() {
            self.stage = Stage::Rectangle(rectangular::Capture::new(self.host, self.ids));
        } else {
            self.planar();
        }
    }

    /// 2D capture (flag-gated). Cheap when it misses (profile recovery only,
    /// no meshing); tried after the parametric path so rect+rect hosts keep
    /// their output and only the remaining hosts reach the 2D re-extrude.
    fn planar(&mut self) {
        if bool2d_path::enabled() {
            self.stage = Stage::Planar(planar::Capture::new(self.host, self.ids));
        } else {
            self.finish(None);
        }
    }

    fn finish(&mut self, bool2d: Option<Bool2dCut>) {
        self.stage = Stage::Complete;
        self.next = Some(OpeningPoll::Complete(Ok(OpeningOutput::Context(
            VoidContext {
                openings: std::mem::take(&mut self.openings),
                merged_openings: std::mem::take(&mut self.merged_openings),
                param: self.param.take(),
                bool2d,
            },
        ))));
    }

    pub(super) fn source(
        &self,
        source: OpeningSource,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> OpeningReply {
        match &self.stage {
            Stage::Classify(stage) => stage.source(source, router, decoder),
            Stage::Rectangle(stage) => stage.source(source, router, decoder),
            Stage::Planar(stage) => stage.source(source, router, decoder),
            Stage::Waiting | Stage::Complete => {
                OpeningReply::Refused(protocol("host openings source"))
            }
        }
    }

    pub(super) fn child(&self, router: &GeometryRouter) -> Result<OpeningChild<'_>> {
        match &self.stage {
            Stage::Classify(stage) => stage.child(router),
            Stage::Rectangle(stage) => stage.child(router),
            Stage::Planar(stage) => stage.child(router),
            Stage::Waiting | Stage::Complete => Err(protocol("host openings child")),
        }
    }

    pub(super) fn resume(&mut self, reply: OpeningReply, router: &GeometryRouter) {
        match (&mut self.stage, reply) {
            (Stage::Classify(stage), reply) => stage.resume(reply, router),
            (Stage::Rectangle(stage), reply) => stage.resume(reply),
            (Stage::Planar(stage), reply) => stage.resume(reply, router),
            (Stage::Waiting, OpeningReply::Merged(openings, merged_openings)) => {
                self.openings = openings;
                self.merged_openings = merged_openings;
                self.rectangle();
            }
            (_, OpeningReply::Refused(error)) => self.next = Some(self.fail(error)),
            _ => self.next = Some(self.fail(protocol("host openings reply"))),
        }
    }
}
