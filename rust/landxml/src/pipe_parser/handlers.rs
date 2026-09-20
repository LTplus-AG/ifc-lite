// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{
    xml::{attr, error, Attributes, Result},
    LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlPipeProperties, LandXmlSourceId,
};

use super::{
    state::{
        CaptureOwner, FlowInput, FlowKind, InvertInput, PartInput, PipeBuilder, PositionCapture,
        PositionInput, RawUnits, StructureBuilder,
    },
    PipeParser,
};

impl PipeParser<'_> {
    pub(super) fn check_cancel_and_work(&mut self, added: usize) -> Result<()> {
        if self
            .cancelled
            .is_some_and(LandXmlCancellation::is_cancelled)
        {
            return Err(error(Code::Cancelled, "ingestion cancelled"));
        }
        self.work = self
            .work
            .checked_add(added)
            .ok_or_else(|| error(Code::LimitExceeded, "work limit exceeded"))?;
        if self.work > self.limits.max_work {
            return Err(error(Code::LimitExceeded, "work limit exceeded"));
        }
        Ok(())
    }

    pub(super) fn check_character_references(&mut self, added: usize) -> Result<()> {
        self.character_references = self
            .character_references
            .checked_add(added)
            .ok_or_else(|| error(Code::LimitExceeded, "character reference limit exceeded"))?;
        if self.character_references > self.limits.max_character_references {
            return Err(error(
                Code::LimitExceeded,
                "character reference limit exceeded",
            ));
        }
        Ok(())
    }

    pub(super) fn reserve(value: &mut usize, maximum: usize, label: &str) -> Result<()> {
        *value = value.checked_add(1).ok_or_else(|| {
            crate::xml::error(Code::LimitExceeded, format!("{label} limit exceeded"))
        })?;
        if *value > maximum {
            return Err(crate::xml::error(
                Code::LimitExceeded,
                format!("{label} limit exceeded"),
            ));
        }
        Ok(())
    }

    pub(super) fn start_structure(
        &mut self,
        properties: LandXmlPipeProperties,
        attributes: &Attributes,
    ) -> Result<()> {
        Self::reserve(
            &mut self.structures_seen,
            self.limits.max_pipe_structures,
            "pipe structure",
        )?;
        let network = self.network.as_mut().expect("structure path has network");
        network.structure_ordinal += 1;
        let ordinal = network.structure_ordinal;
        let source_path = format!("{}/Structs[1]/Struct[{ordinal}]", network.source_path);
        self.structure = Some(StructureBuilder {
            source_id: LandXmlSourceId(format!("{}:structure:{ordinal}", network.source_id.0)),
            source_path,
            name: attr(attributes, "name").map(str::to_owned),
            properties,
            center: None,
            part: None,
            inverts: Vec::new(),
            flow: None,
            invert_ordinal: 0,
            invalid_reason: None,
        });
        Ok(())
    }

    pub(super) fn start_pipe(
        &mut self,
        properties: LandXmlPipeProperties,
        attributes: &Attributes,
    ) -> Result<()> {
        Self::reserve(&mut self.pipes_seen, self.limits.max_pipes, "pipe")?;
        let network = self.network.as_mut().expect("pipe path has network");
        network.pipe_ordinal += 1;
        let ordinal = network.pipe_ordinal;
        let source_path = format!("{}/Pipes[1]/Pipe[{ordinal}]", network.source_path);
        self.pipe = Some(PipeBuilder {
            source_id: LandXmlSourceId(format!("{}:pipe:{ordinal}", network.source_id.0)),
            source_path,
            name: attr(attributes, "name").map(str::to_owned),
            start_ref: attr(attributes, "refStart").map(str::to_owned),
            end_ref: attr(attributes, "refEnd").map(str::to_owned),
            properties,
            part: None,
            center: None,
            flow: None,
            invalid_reason: None,
        });
        Ok(())
    }

    pub(super) fn record_units(&mut self, properties: LandXmlPipeProperties) -> Result<()> {
        let units = RawUnits { properties };
        if self.is_path(&["LandXML", "Units", "Metric"])
            || self.is_path(&["LandXML", "Units", "Imperial"])
        {
            if self.root_units.replace(units).is_some() {
                return Err(crate::xml::error(
                    Code::InvalidSemantic,
                    "LandXML may declare root units only once",
                ));
            }
        } else if self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Structs",
            "Units",
            "Metric",
        ]) || self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Structs",
            "Units",
            "Imperial",
        ]) {
            let network = self.network.as_mut().expect("units path has network");
            if network.structure_units.replace(units).is_some() {
                return Err(crate::xml::error(
                    Code::InvalidSemantic,
                    "Structs may declare units only once",
                ));
            }
        } else if self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Pipes",
            "Units",
            "Metric",
        ]) || self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Pipes",
            "Units",
            "Imperial",
        ]) {
            let network = self.network.as_mut().expect("units path has network");
            if network.pipe_units.replace(units).is_some() {
                return Err(crate::xml::error(
                    Code::InvalidSemantic,
                    "Pipes may declare units only once",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn start_center(&mut self, attributes: &Attributes) -> Result<()> {
        let owner = if self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Structs",
            "Struct",
            "Center",
        ]) {
            CaptureOwner::Structure
        } else if self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Pipes",
            "Pipe",
            "Center",
        ]) {
            CaptureOwner::Pipe
        } else {
            return Ok(());
        };
        let duplicate = match owner {
            CaptureOwner::Structure => self
                .structure
                .as_ref()
                .expect("structure center active")
                .center
                .is_some(),
            CaptureOwner::Pipe => self
                .pipe
                .as_ref()
                .expect("pipe center active")
                .center
                .is_some(),
        };
        if duplicate {
            match owner {
                CaptureOwner::Structure => self
                    .structure
                    .as_mut()
                    .expect("structure center active")
                    .invalid_reason
                    .get_or_insert_with(|| "duplicate Center geometry".to_owned()),
                CaptureOwner::Pipe => self
                    .pipe
                    .as_mut()
                    .expect("pipe center active")
                    .invalid_reason
                    .get_or_insert_with(|| "duplicate Center geometry".to_owned()),
            };
            return Ok(());
        }
        self.capture = Some(PositionCapture {
            depth: self.frames.len(),
            owner,
            input: PositionInput {
                text: String::new(),
                pnt_ref: attr(attributes, "pntRef").map(str::to_owned),
            },
        });
        Ok(())
    }

    pub(super) fn finish_center(&mut self) -> Result<()> {
        let capture = self.capture.take().expect("center capture checked");
        Self::reserve(
            &mut self.points_seen,
            self.limits.max_points,
            "pipe Center point",
        )?;
        match capture.owner {
            CaptureOwner::Structure => {
                self.structure
                    .as_mut()
                    .expect("structure center active")
                    .center = Some(capture.input)
            }
            CaptureOwner::Pipe => {
                self.pipe.as_mut().expect("pipe center active").center = Some(capture.input)
            }
        }
        Ok(())
    }

    pub(super) fn start_invert(
        &mut self,
        properties: LandXmlPipeProperties,
        attributes: &Attributes,
    ) -> Result<()> {
        Self::reserve(
            &mut self.inverts_seen,
            self.limits.max_pipe_inverts,
            "pipe invert",
        )?;
        let structure = self.structure.as_mut().expect("invert has structure");
        structure.invert_ordinal += 1;
        let ordinal = structure.invert_ordinal;
        structure.inverts.push(InvertInput {
            source_id: LandXmlSourceId(format!("{}:invert:{ordinal}", structure.source_id.0)),
            source_path: format!("{}/Invert[{ordinal}]", structure.source_path),
            pipe_ref: attr(attributes, "refPipe").map(str::to_owned),
            flow_direction: attr(attributes, "flowDir").map(str::to_owned),
            elevation: attr(attributes, "elev").map(str::to_owned),
            properties,
        });
        Ok(())
    }

    pub(super) fn start_flow(
        &mut self,
        properties: LandXmlPipeProperties,
        attributes: &Attributes,
        structure_flow: bool,
    ) -> Result<()> {
        Self::reserve(
            &mut self.flows_seen,
            self.limits.max_pipe_flows,
            "pipe flow",
        )?;
        let (source_id, source_path) = if structure_flow {
            let structure = self
                .structure
                .as_ref()
                .expect("structure flow has structure");
            (
                LandXmlSourceId(format!("{}:flow", structure.source_id.0)),
                format!("{}/StructFlow", structure.source_path),
            )
        } else {
            let pipe = self.pipe.as_ref().expect("pipe flow has pipe");
            (
                LandXmlSourceId(format!("{}:flow", pipe.source_id.0)),
                format!("{}/PipeFlow", pipe.source_path),
            )
        };
        let flow = FlowInput {
            kind: if structure_flow {
                FlowKind::Structure
            } else {
                FlowKind::Pipe
            },
            source_id,
            source_path,
            flow_in: attr(attributes, "flowIn").map(str::to_owned),
            loss_in: attr(attributes, "lossIn").map(str::to_owned),
            loss_out: attr(attributes, "lossOut").map(str::to_owned),
            properties,
        };
        if structure_flow {
            let structure = self
                .structure
                .as_mut()
                .expect("structure flow has structure");
            if structure.flow.replace(flow).is_some() {
                structure
                    .invalid_reason
                    .get_or_insert_with(|| "duplicate StructFlow".to_owned());
            }
        } else {
            let pipe = self.pipe.as_mut().expect("pipe flow has pipe");
            if pipe.flow.replace(flow).is_some() {
                pipe.invalid_reason
                    .get_or_insert_with(|| "duplicate PipeFlow".to_owned());
            }
        }
        Ok(())
    }

    pub(super) fn start_pipe_part(
        &mut self,
        local: &str,
        properties: LandXmlPipeProperties,
    ) -> Result<()> {
        if !self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Pipes",
            "Pipe",
            local,
        ]) {
            return Ok(());
        }
        let part = match local {
            "CircPipe" => PartInput::Circ { properties },
            "ElliPipe" => PartInput::Elli { properties },
            "EggPipe" => PartInput::Egg { properties },
            "RectPipe" => PartInput::Rect { properties },
            "Channel" => PartInput::Channel,
            _ => unreachable!("pipe parts are filtered by caller"),
        };
        let pipe = self.pipe.as_mut().expect("part has pipe");
        if pipe.part.replace(part).is_some() {
            pipe.invalid_reason
                .get_or_insert_with(|| "conflicting pipe cross-section geometry".to_owned());
        }
        Ok(())
    }

    pub(super) fn start_structure_part(
        &mut self,
        local: &str,
        properties: LandXmlPipeProperties,
    ) -> Result<()> {
        if !self.is_path(&[
            "LandXML",
            "PipeNetworks",
            "PipeNetwork",
            "Structs",
            "Struct",
            local,
        ]) {
            return Ok(());
        }
        let part = match local {
            "CircStruct" => PartInput::StructCirc { properties },
            "RectStruct" => PartInput::StructRect { properties },
            "InletStruct" => PartInput::Inlet { properties },
            "OutletStruct" => PartInput::Outlet { properties },
            "Connection" => PartInput::Connection { properties },
            _ => unreachable!("structure parts are filtered by caller"),
        };
        let structure = self.structure.as_mut().expect("part has structure");
        if structure.part.replace(part).is_some() {
            structure
                .invalid_reason
                .get_or_insert_with(|| "conflicting structure part geometry".to_owned());
        }
        Ok(())
    }
}
