// SPDX-License-Identifier: MPL-2.0
//! Owned opening children. Common-program identity validation precedes resume.
use super::requests::{OpeningChild, OpeningReady, OpeningReply, OpeningSource};
use super::{planar, rectangular, Classifier, HostOpenings};
use crate::program::opening::{OpeningBounds, OpeningProgram};
use crate::router::voids::{bool2d_path::Bool2dCut, OpeningType, ParamRectCut, ReadyVoidContext};
use crate::{GeometryRouter, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use std::sync::Arc;

pub(crate) enum OpeningOutput {
    Context(Arc<ReadyVoidContext>),
    Classified(Vec<OpeningType>),
    Meshes(Vec<Mesh>),
    Bounds(OpeningBounds),
    Rectangle(Option<ParamRectCut>),
    Planar(Option<Bool2dCut>),
}
pub(crate) enum OpeningPoll {
    Source(OpeningSource),
    Ready(OpeningReady),
    Geometry(OpeningChild),
    Complete(Result<OpeningOutput>),
    Pending,
}
pub(crate) enum Step {
    Poll(OpeningPoll),
    Child(OpeningControl),
}
enum Machine {
    Host(HostOpenings),
    Classifier(Classifier),
    Probe(OpeningProgram),
    Rectangle(rectangular::Capture),
    Planar(planar::Capture),
}
pub(crate) struct OpeningControl {
    machine: Option<Machine>,
    child: Option<Box<OpeningControl>>,
    error: Option<crate::Error>,
    reports: crate::construction::ConstructionReports,
}
impl OpeningControl {
    fn new(machine: Machine) -> Self {
        Self {
            machine: Some(machine),
            child: None,
            error: None,
            reports: Default::default(),
        }
    }
    pub(crate) fn context(host: DecodedEntity, ids: Vec<u32>) -> Self {
        Self::new(Machine::Host(HostOpenings::from_owned(host, ids)))
    }
    pub(crate) fn classifier(host: DecodedEntity, ids: Vec<u32>, recording: bool) -> Self {
        Self::new(Machine::Classifier(Classifier::from_owned(
            host, ids, recording,
        )))
    }
    pub(crate) fn probe(element: DecodedEntity, meshes: bool) -> Self {
        Self::new(Machine::Probe(OpeningProgram::new(element, meshes)))
    }
    #[cfg(test)]
    pub(super) fn from_host(program: HostOpenings) -> Self {
        Self::new(Machine::Host(program))
    }
    pub(in crate::program) fn from_probe(program: OpeningProgram) -> Self {
        Self::new(Machine::Probe(program))
    }
    #[cfg(test)]
    pub(super) fn from_classifier(program: Classifier) -> Self {
        Self::new(Machine::Classifier(program))
    }
    pub(super) fn rectangle(host: DecodedEntity, ids: Vec<u32>) -> Self {
        Self::new(Machine::Rectangle(rectangular::Capture::new(host, ids)))
    }
    pub(super) fn planar(host: DecodedEntity, ids: Vec<u32>) -> Self {
        Self::new(Machine::Planar(planar::Capture::new(host, ids)))
    }
    pub(crate) fn poll(&mut self) -> OpeningPoll {
        loop {
            if let Some(error) = self.error.take() {
                return OpeningPoll::Complete(Err(error));
            }
            if let Some(child) = &mut self.child {
                match child.poll() {
                    OpeningPoll::Complete(output) => {
                        self.reports.merge(child.take_reports());
                        self.child = None;
                        if let Err(error) = self.child_complete(output) {
                            self.error = Some(error)
                        }
                        continue;
                    }
                    poll => return poll,
                }
            }
            let step = match self.machine.as_mut().expect("active opening machine") {
                Machine::Host(machine) => machine.poll(),
                Machine::Classifier(machine) => machine.poll(),
                Machine::Probe(machine) => machine.poll(),
                Machine::Rectangle(machine) => machine.poll(),
                Machine::Planar(machine) => machine.poll(),
            };
            match step {
                Step::Poll(poll) => return poll,
                Step::Child(child) => self.child = Some(Box::new(child)),
            }
        }
    }
    pub(crate) fn resume(&mut self, reply: OpeningReply, router: &GeometryRouter) {
        if let Some(child) = &mut self.child {
            child.resume(reply, router);
            return;
        }
        let mut reply = reply;
        let reply = loop {
            match reply {
                OpeningReply::Captured(value, reports) => {
                    self.reports.merge(reports);
                    reply = *value;
                }
                OpeningReply::Numerical(_, value) => reply = *value,
                value => break value,
            }
        };
        if let OpeningReply::Error(error) = reply {
            self.error = Some(error);
            return;
        }
        if let Err(stop) = crate::resource::check_current() {
            self.error = Some(stop.into());
            return;
        }
        let result = match self.machine.as_mut().expect("active opening machine") {
            Machine::Host(machine) => machine.resume(reply),
            Machine::Classifier(machine) => machine.resume(reply, router),
            Machine::Probe(machine) => machine.resume(reply),
            Machine::Rectangle(machine) => machine.resume(reply),
            Machine::Planar(machine) => machine.resume(reply),
        };
        if let Err(error) = result {
            self.error = Some(error)
        }
    }
    fn child_complete(&mut self, output: Result<OpeningOutput>) -> Result<()> {
        match self.machine.as_mut().expect("active opening machine") {
            Machine::Host(machine) => machine.child_complete(output),
            Machine::Classifier(machine) => machine.child_complete(output),
            Machine::Rectangle(machine) => machine.child_complete(output),
            Machine::Planar(machine) => machine.child_complete(output),
            Machine::Probe(_) => unreachable!("probe has only common geometry children"),
        }
    }
    pub(crate) fn cancel(&mut self) {
        self.child = None;
        self.machine = None;
        self.error = Some(crate::resource::ProgramStop::Cancelled.into());
    }
    pub(crate) fn take_reports(&mut self) -> crate::construction::ConstructionReports {
        let mut reports = std::mem::take(&mut self.reports);
        if let Some(child) = &mut self.child {
            reports.merge(child.take_reports());
        }
        reports
    }
    /// Compatibility callers drain the same operations and actual canonical
    /// geometry children. No source request executes a descendant walk.
    pub(crate) fn drain(
        mut self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> Result<OpeningOutput> {
        let mut guard = DrainReports(&mut self);
        let control = &mut guard.0;
        loop {
            crate::resource::check_current()?;
            let reply = match control.poll() {
                OpeningPoll::Source(source) => source.execute(router, decoder),
                OpeningPoll::Ready(ready) => ready.execute(),
                OpeningPoll::Geometry(child) => {
                    let result = child.admit(router).and_then(|(mut program, mesh)| {
                        while let Some(request) = program
                            .request()
                            .expect("synchronous opening child request")
                        {
                            let reply = program
                                .execute(request, router, decoder)
                                .expect("synchronous opening child execute");
                            program
                                .accept(reply, router)
                                .expect("synchronous opening child accept");
                        }
                        if mesh {
                            program.finish().map(|mesh| vec![mesh])
                        } else {
                            program.finish_parts()
                        }
                    });
                    OpeningReply::Parts(result)
                }
                OpeningPoll::Complete(output) => return output,
                OpeningPoll::Pending => {
                    return Err(crate::Error::geometry("Opening reply remains pending"))
                }
            };
            control.resume(reply, router);
        }
    }
}

struct DrainReports<'a>(&'a mut OpeningControl);
impl Drop for DrainReports<'_> {
    fn drop(&mut self) {
        crate::processors::diagnostic_capture::restore(&self.0.take_reports());
    }
}
