// SPDX-License-Identifier: MPL-2.0
//! The cut frame of one voided host (`router::transforms::cut_frame`): chosen
//! on the first request, given up when the host's geometry outgrows it, and
//! undone once by placing the finished cut.
use super::{hosts_complete, Phase, VoidControl};
use crate::program::product::{ProductControl, ProductOutput};
use crate::router::processing::SourceHygiene;
use crate::{GeometryRouter, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// The walk of a host that has openings to cut.
pub(super) fn host_walk(host: &DecodedEntity, styled: bool) -> ProductControl<'_> {
    if styled {
        ProductControl::styled(host, false, None, SourceHygiene::BooleanOperand)
    } else {
        ProductControl::merged(host, SourceHygiene::BooleanOperand)
    }
}

impl<'a> VoidControl<'a> {
    /// Choose the cut frame: the chain root's when the host's walk is still
    /// ahead and there is something to cut.
    pub(super) fn choose_frame(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder) {
        let own_frame = matches!(&self.phase, Phase::Host(_, ids) if !ids.is_empty());
        self.frame.choose(self.host, own_frame, router, decoder);
    }

    /// The host walk completed. A host that outgrew its root frame is walked
    /// again in the caller's; otherwise its void context is captured.
    pub(super) fn hosts_walked(&mut self, ids: &'a [u32], hosts: Result<ProductOutput>) -> Phase<'a> {
        let outgrown = match &hosts {
            Ok(ProductOutput::Parts(parts)) => self.frame.outgrown_by(parts.iter()),
            Ok(ProductOutput::Styled(subs)) => self.frame.outgrown_by(subs.parts.iter().map(|part| &part.sub.mesh)),
            _ => false,
        };
        if outgrown {
            return Phase::Host(host_walk(self.host, self.styled), ids);
        }
        hosts_complete(self.host, ids, hosts)
    }

    /// Place a completed cut into the caller's frame, once.
    pub(super) fn place(&mut self, router: &GeometryRouter) {
        let Phase::Complete(Ok(output)) = &mut self.phase else {
            return;
        };
        let Some(at) = self.frame.take_placement() else {
            return;
        };
        match output {
            ProductOutput::Parts(parts) => {
                parts.iter_mut().for_each(|part| router.place_root_frame_cut(part, &at))
            }
            ProductOutput::Styled(subs) => {
                subs.subs_mut(0).for_each(|sub| router.place_root_frame_cut_sub(sub, &at))
            }
            ProductOutput::Retained(..) => {}
        }
    }
}
