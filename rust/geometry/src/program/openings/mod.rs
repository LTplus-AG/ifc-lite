// SPDX-License-Identifier: MPL-2.0
//! Common host-opening child control: ordered source admission, then ready cuts.
mod classify;
mod decision;
mod effects;
pub(crate) mod execute;
mod planar;
mod rectangular;
use crate::router::voids::VoidContext;
use crate::{resource, GeometryRouter};
pub(crate) use classify::Classifier;
use ifc_lite_core::{DecodedEntity, EntityDecoder};

pub(crate) struct HostOpenings {
    host: DecodedEntity,
    ids: Vec<u32>,
    phase: Phase,
    context: VoidContext,
}
enum Phase {
    Classify,
    Merge,
    Rectangular,
    Planar,
    Ready,
}
impl HostOpenings {
    pub(crate) fn new(host: &DecodedEntity, ids: &[u32]) -> Self {
        Self {
            host: host.clone(),
            ids: ids.to_vec(),
            phase: Phase::Classify,
            context: VoidContext {
                openings: Vec::new(),
                merged_openings: Vec::new(),
                param: None,
                bool2d: None,
            },
        }
    }
    pub(crate) fn run(
        mut self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> crate::Result<VoidContext> {
        resource::check_current()?;
        loop {
            resource::check_current()?;
            match self.phase {
                Phase::Classify => {
                    self.context.openings =
                        Classifier::new(&self.host, &self.ids, true).run(router, decoder)?;
                    resource::check_current()?;
                    self.phase = Phase::Merge;
                }
                Phase::Merge => {
                    self.context.merged_openings =
                        GeometryRouter::merge_rectangular_openings(&self.context.openings);
                    resource::check_current()?;
                    self.phase = Phase::Rectangular;
                }
                Phase::Rectangular => {
                    if crate::rect_fast::param_enabled() {
                        self.context.param =
                            rectangular::Capture::run(&self.host, &self.ids, router, decoder)?;
                    }
                    resource::check_current()?;
                    self.phase = Phase::Planar;
                }
                Phase::Planar => {
                    if crate::router::voids::bool2d_path::enabled() {
                        self.context.bool2d =
                            planar::Capture::run(&self.host, &self.ids, router, decoder)?;
                    }
                    resource::check_current()?;
                    self.phase = Phase::Ready;
                }
                Phase::Ready => return Ok(self.context),
            }
        }
    }
}

/// Preserve historical source-fault recovery without losing a typed or sticky stop.
fn source_option<T>(result: crate::Result<T>) -> crate::Result<Option<T>> {
    match resource::observe(result) {
        Ok(value) => Ok(Some(value)),
        Err(error @ crate::Error::ProgramStopped(_)) => Err(error),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod terminal_tests;

#[cfg(test)]
mod raw_terminal_tests;
