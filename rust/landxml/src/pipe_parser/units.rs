// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{xml::Result, LandXmlDiagnosticCode as Code, LandXmlPipeProperties};

use super::{state::RawUnits, PipeParser};

impl PipeParser<'_> {
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
}
