// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::HashMap;

use crate::{
    xml::{error, Result},
    LandXmlDiagnosticCode as Code, LandXmlPipe, LandXmlPipeConnectivity, LandXmlPipeGeometry,
    LandXmlPipeNetwork, LandXmlPipeStructure, LandXmlPipeUnits, LandXmlSourceId,
};

use super::{
    convert,
    state::{InvertInput, PipeBuilder, StructureBuilder},
    PipeParser,
};

mod document;
pub(in crate::pipe_parser) mod helpers;

type StructureConversion = (
    Vec<LandXmlPipeStructure>,
    Vec<(Vec<InvertInput>, LandXmlPipeUnits)>,
);

impl PipeParser<'_> {
    pub(super) fn finish_network(&mut self, network: super::state::NetworkBuilder) -> Result<()> {
        let source_id = network.source_id.clone();
        let source_path = network.source_path.clone();
        let Some(name) = helpers::non_empty(network.name) else {
            self.refuse(source_id, source_path, "PipeNetwork is missing name")?;
            return Ok(());
        };
        let Some(pipe_network_type) = helpers::non_empty(network.pipe_network_type) else {
            self.refuse(source_id, source_path, "PipeNetwork is missing pipeNetType")?;
            return Ok(());
        };
        if !network.saw_structs || !network.saw_pipes {
            self.refuse(
                source_id,
                source_path,
                "PipeNetwork requires Structs and Pipes collections",
            )?;
            return Ok(());
        }
        let root_units = self.root_units.clone();
        let (structures, structure_inputs) =
            self.convert_structures(network.structures, root_units.as_ref())?;
        let structure_names = helpers::unique_names(
            self,
            structures
                .iter()
                .map(|structure| (&structure.name, &structure.source_id)),
        )?;
        let (pipes, pipe_names) =
            self.convert_pipes(network.pipes, root_units.as_ref(), &structure_names)?;
        let pipe_connectivity = pipes
            .iter()
            .map(|pipe| (pipe.source_id.clone(), pipe.connectivity.clone()))
            .collect::<HashMap<_, _>>();
        let pipe_paths = pipes
            .iter()
            .map(|pipe| (pipe.source_id.clone(), pipe.source_path.clone()))
            .collect::<HashMap<_, _>>();
        let mut structures = structures;
        for (structure, (inverts, units)) in structures.iter_mut().zip(structure_inputs) {
            structure.inverts = self.convert_inverts(
                inverts,
                &units,
                &pipe_names,
                &structure.source_id,
                &pipe_connectivity,
                &pipe_paths,
            )?;
        }
        let structure_units = self.convert_units(
            network.structure_units.as_ref().or(root_units.as_ref()),
            &source_id,
            &source_path,
        )?;
        let pipe_units = self.convert_units(
            network.pipe_units.as_ref().or(root_units.as_ref()),
            &source_id,
            &source_path,
        )?;
        self.networks.push(LandXmlPipeNetwork {
            source_id,
            source_path,
            name,
            pipe_network_type,
            properties: network.properties,
            features: network.features,
            structure_units,
            pipe_units,
            structures,
            pipes,
        });
        Ok(())
    }

    fn convert_structures(
        &mut self,
        inputs: Vec<StructureBuilder>,
        root_units: Option<&super::state::RawUnits>,
    ) -> Result<StructureConversion> {
        let duplicates = helpers::duplicate_names(
            self,
            inputs.iter().filter_map(|input| input.name.as_deref()),
        )?;
        let mut structures = Vec::new();
        let mut inverts = Vec::new();
        for input in inputs {
            self.check_cancel_and_work(1)?;
            if input
                .name
                .as_deref()
                .is_some_and(|name| duplicates.contains(name))
            {
                self.refuse(input.source_id, input.source_path, "duplicate Struct name")?;
                continue;
            }
            let Some(units) = self.convert_units(
                input.units.as_ref().or(root_units),
                &input.source_id,
                &input.source_path,
            )?
            else {
                continue;
            };
            if let Some((structure, pending)) = self.convert_structure(input, &units)? {
                structures.push(structure);
                inverts.push((pending, units));
            }
        }
        Ok((structures, inverts))
    }

    fn convert_structure(
        &mut self,
        input: StructureBuilder,
        units: &LandXmlPipeUnits,
    ) -> Result<Option<(LandXmlPipeStructure, Vec<InvertInput>)>> {
        let source_id = input.source_id.clone();
        let source_path = input.source_path.clone();
        let Some(name) = helpers::non_empty(input.name) else {
            self.refuse(source_id, source_path, "Struct is missing name")?;
            return Ok(None);
        };
        let result = (|| {
            if let Some(reason) = input.invalid_reason.as_deref() {
                return Err(reason.to_owned());
            }
            let center = convert::position(
                input.center.as_ref().ok_or("Struct is missing Center")?,
                units,
            )?;
            let part = convert::structure_part(input.part.ok_or("Struct is missing part")?, units)?;
            let rim_elevation = convert::optional_measure(
                &input.properties,
                "elevRim",
                &units.elevation_unit,
                units.elevation_scale_to_meters,
                false,
            )?;
            let sump_elevation = convert::optional_measure(
                &input.properties,
                "elevSump",
                &units.elevation_unit,
                units.elevation_scale_to_meters,
                false,
            )?;
            Ok::<_, String>(LandXmlPipeStructure {
                source_id: source_id.clone(),
                source_path: source_path.clone(),
                name,
                properties: input.properties,
                units: units.clone(),
                center,
                part,
                rim_elevation,
                sump_elevation,
                inverts: Vec::new(),
                flow: None,
            })
        })();
        match result {
            Ok(mut structure) => {
                if let Some(flow) = input.flow {
                    structure.flow = helpers::convert_flow(self, flow, units)?;
                }
                Ok(Some((structure, input.inverts)))
            }
            Err(message) => {
                self.refuse(source_id, source_path, &message)?;
                Ok(None)
            }
        }
    }

    fn convert_pipes(
        &mut self,
        inputs: Vec<PipeBuilder>,
        root_units: Option<&super::state::RawUnits>,
        structures: &HashMap<String, LandXmlSourceId>,
    ) -> Result<(Vec<LandXmlPipe>, HashMap<String, LandXmlSourceId>)> {
        let duplicates = helpers::duplicate_names(
            self,
            inputs.iter().filter_map(|input| input.name.as_deref()),
        )?;
        let mut pipes = Vec::new();
        for input in inputs {
            self.check_cancel_and_work(1)?;
            if input
                .name
                .as_deref()
                .is_some_and(|name| duplicates.contains(name))
            {
                self.refuse(input.source_id, input.source_path, "duplicate Pipe name")?;
            } else {
                let Some(units) = self.convert_units(
                    input.units.as_ref().or(root_units),
                    &input.source_id,
                    &input.source_path,
                )?
                else {
                    continue;
                };
                if let Some(pipe) = self.convert_pipe(input, &units, structures)? {
                    pipes.push(pipe);
                }
            }
        }
        let names =
            helpers::unique_names(self, pipes.iter().map(|pipe| (&pipe.name, &pipe.source_id)))?;
        Ok((pipes, names))
    }

    fn convert_pipe(
        &mut self,
        input: PipeBuilder,
        units: &LandXmlPipeUnits,
        structures: &HashMap<String, LandXmlSourceId>,
    ) -> Result<Option<LandXmlPipe>> {
        let source_id = input.source_id.clone();
        let source_path = input.source_path.clone();
        self.reserve_reference()?;
        self.reserve_reference()?;
        let result = (|| {
            if let Some(reason) = input.invalid_reason.as_deref() {
                return Err(reason.to_owned());
            }
            let name = helpers::non_empty(input.name).ok_or("Pipe is missing name")?;
            let start =
                helpers::required_reference(input.start_ref, "refStart", "structure", structures)?;
            let end =
                helpers::required_reference(input.end_ref, "refEnd", "structure", structures)?;
            let part = convert::pipe_part(
                input.part.ok_or("Pipe is missing cross-section part")?,
                units,
            )?;
            let geometry = input
                .center
                .as_ref()
                .map(|center| {
                    convert::position(center, units)
                        .map(|point| LandXmlPipeGeometry::PassThrough { point })
                })
                .transpose()?
                .unwrap_or(LandXmlPipeGeometry::Straight);
            let length = convert::optional_measure(
                &input.properties,
                "length",
                &units.linear_unit,
                units.linear_scale_to_meters,
                true,
            )?;
            Ok::<_, String>(LandXmlPipe {
                source_id: source_id.clone(),
                source_path: source_path.clone(),
                name,
                properties: input.properties,
                units: units.clone(),
                connectivity: LandXmlPipeConnectivity {
                    start_structure_source_id: start,
                    end_structure_source_id: end,
                },
                part,
                geometry,
                length,
                flow: None,
            })
        })();
        match result {
            Ok(mut pipe) => {
                if let Some(flow) = input.flow {
                    pipe.flow = helpers::convert_flow(self, flow, units)?;
                }
                Ok(Some(pipe))
            }
            Err(message) => {
                self.refuse(source_id, source_path, &message)?;
                Ok(None)
            }
        }
    }

    pub(super) fn refuse(
        &mut self,
        source_id: LandXmlSourceId,
        source_path: String,
        message: &str,
    ) -> Result<()> {
        if self.refusals.len() >= self.limits.max_pipe_refusals {
            return Err(error(Code::LimitExceeded, "pipe refusal limit exceeded"));
        }
        self.refusals.push(crate::LandXmlPipeRefusal {
            source_id,
            source_path,
            code: Code::InvalidSemantic,
            message: message.to_owned(),
        });
        Ok(())
    }

    pub(super) fn reserve_reference(&mut self) -> Result<()> {
        Self::reserve(
            &mut self.references_seen,
            self.limits.max_references,
            "pipe reference",
        )
    }
}
