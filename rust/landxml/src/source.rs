/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Every supported LandXML family from one read of the bytes (C9a-10, #7784,
//! EDGE-LXPARSE-8).
//!
//! Terrain, plan, alignments and pipe networks used to be four parses of the
//! same buffer (three for `parse_landxml_document`, whose pipe pass was
//! recognised by matching an error message). They are handlers on one
//! [`Driver`](crate::xml::Driver), so the bytes are decoded, scanned and
//! parsed once and each family sees every event.

use crate::{
    alignment::{
        parser::AlignmentHandler, LandXmlAlignmentDocument, LandXmlAlignmentLimits,
    },
    parser::TinHandler,
    pipe_parser::PipeHandler,
    plan::{parser::PlanHandler, LandXmlDocument, LandXmlPlanLimits},
    xml::{drive, error, normalize_encoding, FamilyHandler, Meter},
    LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlError, LandXmlLimits,
};

/// Bounds for [`parse_landxml_source_with_cancel`].
///
/// `xml` bounds the one read of the document and wins over the `xml` field
/// nested in `plan` and `alignment`, which is ignored here: the families share
/// one read, so they cannot be given different XML limits.
#[derive(Clone, Debug, Default)]
pub struct LandXmlSourceLimits {
    pub xml: LandXmlLimits,
    pub plan: LandXmlPlanLimits,
    pub alignment: LandXmlAlignmentLimits,
}

/// Terrain, plan and pipe networks (the [`LandXmlDocument`]) and the horizontal
/// alignments of one LandXML source.
#[derive(Clone, Debug, PartialEq)]
pub struct LandXmlSource {
    pub document: LandXmlDocument,
    pub alignments: LandXmlAlignmentDocument,
}

/// Parse terrain, plan, pipe networks and alignments with default limits.
pub fn parse_landxml_source(input: &[u8]) -> Result<LandXmlSource, LandXmlError> {
    parse_landxml_source_with_cancel(input, &LandXmlSourceLimits::default(), None)
}

/// Parse every supported family in one pass, with host limits and
/// cancellation. A terrain-only or alignment-only source returns an honest
/// empty sibling collection.
pub fn parse_landxml_source_with_cancel(
    input: &[u8],
    limits: &LandXmlSourceLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<LandXmlSource, LandXmlError> {
    let (document, alignments) = parse_families(input, limits, cancelled, true)?;
    Ok(LandXmlSource {
        document,
        alignments: alignments.expect("alignments were requested"),
    })
}

/// The one pass. `alignments: false` leaves the alignment family out, so a
/// document whose alignments are malformed still yields its terrain, plan
/// and pipes (what `parse_landxml_document` has always done).
pub(crate) fn parse_families(
    input: &[u8],
    limits: &LandXmlSourceLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
    alignments: bool,
) -> Result<(LandXmlDocument, Option<LandXmlAlignmentDocument>), LandXmlError> {
    if input.len() > limits.xml.max_bytes {
        return Err(error(Code::InputTooLarge, "input exceeds byte limit"));
    }
    // #5175: refuse a bad assumed-unit override before any XML is read.
    let assumed_units = crate::semantics::resolve_assumed_units(&limits.xml)?;
    let input = normalize_encoding(input, &limits.xml, cancelled)?;
    let meter = Meter::new(limits.xml.max_work, cancelled);
    let plan_limits = LandXmlPlanLimits { xml: limits.xml.clone(), ..limits.plan.clone() };
    let alignment_limits = LandXmlAlignmentLimits { xml: limits.xml.clone(), ..limits.alignment.clone() };
    let mut tin = TinHandler::new(&limits.xml, meter.clone(), cancelled, assumed_units.clone());
    let mut plan = PlanHandler::new(&plan_limits, assumed_units.clone());
    let mut pipe = PipeHandler::new(&limits.xml, meter.clone(), false);
    let mut alignment = AlignmentHandler::new(&alignment_limits, false, assumed_units);
    {
        let mut handlers: Vec<&mut dyn FamilyHandler> = vec![&mut tin, &mut plan, &mut pipe];
        if alignments {
            handlers.push(&mut alignment);
        }
        drive(&input, &limits.xml, cancelled, meter, &mut handlers)?;
    }
    let mut terrain = tin.finish()?;
    let (pipes, _, has_pipe_networks) = pipe.finish_stream_with_preflight()?;
    terrain.pipe_networks = has_pipe_networks.then_some(pipes);
    let document = LandXmlDocument { terrain, plan: plan.document() };
    let alignments = alignments.then(|| alignment.finish()).transpose()?;
    Ok((document, alignments))
}
