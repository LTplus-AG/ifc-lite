// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{
    xml::{error, Result},
    LandXmlDiagnosticCode as Code, LandXmlPipeNetworkDocument, LandXmlPipeUnits, LandXmlSourceId,
};

use super::super::{convert, state::RawUnits, PipeParser};

impl PipeParser<'_> {
    /// Finalize the shared parser after either pull or stream event delivery.
    pub(crate) fn finish_stream(self) -> Result<LandXmlPipeNetworkDocument> {
        self.finish_stream_with_preflight()
            .map(|(document, _, _)| document)
    }

    /// Preserve source-document output while carrying cursor-only refusal
    /// probes for each retained network. The indexes keep the extra state
    /// compact and never expose a presentation-only field in LandXML data.
    pub(crate) fn finish_stream_with_preflight(
        mut self,
    ) -> Result<(LandXmlPipeNetworkDocument, Vec<Vec<usize>>, bool)> {
        if self.require_pipe_networks && self.pipe_networks_seen == 0 {
            return Err(error(
                Code::InvalidSemantic,
                "document contains no PipeNetwork records",
            ));
        }
        for network in std::mem::take(&mut self.pending_networks) {
            self.check_cancel_and_work(1)?;
            self.finish_network(network)?;
        }
        let root_units = self
            .root_units
            .as_ref()
            .map(convert::units)
            .transpose()
            .map_err(|message| error(Code::InvalidSemantic, message))?;
        debug_assert_eq!(self.networks.len(), self.preflight_refusal_batches.len());
        let preflight_refusal_batches = self.preflight_refusal_batches;
        let has_pipe_networks = self.pipe_networks_seen > 0;
        Ok((
            LandXmlPipeNetworkDocument {
                schema: self.schema,
                version: self.version,
                capability_diagnostics: self.capability_diagnostics,
                root_units,
                collections: self.collections,
                features: self.features,
                networks: self.networks,
                refusals: self.refusals,
            },
            preflight_refusal_batches,
            has_pipe_networks,
        ))
    }

    pub(super) fn convert_units(
        &mut self,
        units: Option<&RawUnits>,
        source_id: &LandXmlSourceId,
        source_path: &str,
    ) -> Result<Option<LandXmlPipeUnits>> {
        let Some(units) = units else {
            self.refuse(
                source_id.clone(),
                source_path.to_owned(),
                "pipe-network element requires Units",
            )?;
            return Ok(None);
        };
        match convert::units(units) {
            Ok(units) => Ok(Some(units)),
            Err(message) => {
                self.refuse(source_id.clone(), source_path.to_owned(), &message)?;
                Ok(None)
            }
        }
    }
}
