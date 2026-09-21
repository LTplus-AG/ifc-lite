// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::HashMap;

use crate::{
    xml::Result, LandXmlPipeConnectivity, LandXmlPipeInvert, LandXmlPipeUnits, LandXmlSourceId,
};

use super::{convert, finalize::helpers, state::InvertInput, PipeParser};

impl PipeParser<'_> {
    pub(super) fn convert_inverts(
        &mut self,
        inputs: Vec<InvertInput>,
        units: &LandXmlPipeUnits,
        pipes: &HashMap<String, LandXmlSourceId>,
        structure_source_id: &LandXmlSourceId,
        pipe_connectivity: &HashMap<LandXmlSourceId, LandXmlPipeConnectivity>,
        pipe_paths: &HashMap<LandXmlSourceId, String>,
    ) -> Result<Vec<LandXmlPipeInvert>> {
        let mut inverts = Vec::new();
        for input in inputs {
            self.check_cancel_and_work(1)?;
            let source_id = input.source_id.clone();
            let source_path = input.source_path.clone();
            let pipe_name = input.pipe_ref.clone();
            self.reserve_reference()?;
            let result = (|| {
                let pipe_source_id =
                    helpers::required_reference(input.pipe_ref, "refPipe", "pipe", pipes)?;
                let flow_direction = match input.flow_direction.as_deref() {
                    Some("in" | "out" | "both") => input.flow_direction.expect("checked"),
                    _ => return Err("Invert has invalid flowDir".to_owned()),
                };
                let connectivity = pipe_connectivity
                    .get(&pipe_source_id)
                    .ok_or("refPipe references unavailable pipe connectivity")?;
                let matches_endpoint = match flow_direction.as_str() {
                    "in" => connectivity.end_structure_source_id == *structure_source_id,
                    "out" => connectivity.start_structure_source_id == *structure_source_id,
                    "both" => {
                        connectivity.start_structure_source_id == *structure_source_id
                            || connectivity.end_structure_source_id == *structure_source_id
                    }
                    _ => unreachable!("flow direction is checked above"),
                };
                if !matches_endpoint {
                    return Err(
                        "Invert flowDir does not match the referenced pipe endpoint".to_owned()
                    );
                }
                let elevation =
                    convert::elevation(&input.elevation.ok_or("Invert is missing elev")?, units)?;
                Ok::<_, String>(LandXmlPipeInvert {
                    source_id: source_id.clone(),
                    source_path: source_path.clone(),
                    pipe_source_id,
                    flow_direction,
                    elevation,
                    properties: input.properties,
                })
            })();
            match result {
                Ok(invert) => inverts.push(invert),
                Err(message) => {
                    self.refuse(source_id, source_path, &message)?;
                    self.refuse_affected_pipe_for_invert(
                        pipe_name.as_deref(),
                        pipes,
                        structure_source_id,
                        pipe_connectivity,
                        pipe_paths,
                        "an authored endpoint Invert is invalid",
                    )?;
                }
            }
        }
        let mut accepted: Vec<LandXmlPipeInvert> = Vec::new();
        for invert in inverts {
            if let Some(existing) = accepted.iter().find(|existing| {
                existing.pipe_source_id == invert.pipe_source_id
                    && existing.flow_direction == invert.flow_direction
            }) {
                if elevations_match(existing.elevation.meters, invert.elevation.meters) {
                    continue;
                }
                self.refuse_pipe_once(
                    invert.pipe_source_id.clone(),
                    pipe_paths
                        .get(&invert.pipe_source_id)
                        .expect("converted Invert pipe has a source path")
                        .clone(),
                    "conflicting authored endpoint Invert elevations",
                )?;
            }
            accepted.push(invert);
        }
        Ok(accepted)
    }

    fn refuse_affected_pipe_for_invert(
        &mut self,
        pipe_name: Option<&str>,
        pipes: &HashMap<String, LandXmlSourceId>,
        structure_source_id: &LandXmlSourceId,
        pipe_connectivity: &HashMap<LandXmlSourceId, LandXmlPipeConnectivity>,
        pipe_paths: &HashMap<LandXmlSourceId, String>,
        message: &str,
    ) -> Result<()> {
        let Some(pipe_source_id) = pipe_name.and_then(|name| pipes.get(name)) else {
            return Ok(());
        };
        let Some(connectivity) = pipe_connectivity.get(pipe_source_id) else {
            return Ok(());
        };
        if connectivity.start_structure_source_id != *structure_source_id
            && connectivity.end_structure_source_id != *structure_source_id
        {
            return Ok(());
        }
        self.refuse_pipe_once(
            pipe_source_id.clone(),
            pipe_paths
                .get(pipe_source_id)
                .expect("available pipe connectivity has a source path")
                .clone(),
            message,
        )
    }

    fn refuse_pipe_once(
        &mut self,
        source_id: LandXmlSourceId,
        source_path: String,
        message: &str,
    ) -> Result<()> {
        if self
            .refusals
            .iter()
            .any(|refusal| refusal.source_id == source_id && refusal.message == message)
        {
            return Ok(());
        }
        self.refuse(source_id, source_path, message)
    }
}

/// Authored elevations are equal only within one nanometre in metres. This
/// intentionally remains physically bounded at large coordinates: a one-metre
/// difference is always a conflicting endpoint, even when f64 ULPs are large.
fn elevations_match(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1e-9
}
