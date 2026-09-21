// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! LandXML horizontal alignment semantics and deterministic numeric probes.

mod inspection;
mod model;
mod numeric;
mod parser;

pub use inspection::LandXmlCantProbe;
pub use model::*;
pub use numeric::{
    LandXmlAlignmentProbe, LandXmlNumericDiagnostic, LandXmlStationMapping,
    MAX_INTERACTIVE_STATION_PROBES,
};
pub use parser::{
    parse_landxml_alignments, parse_landxml_alignments_optional,
    parse_landxml_alignments_optional_with_cancel, parse_landxml_alignments_with_cancel,
    LandXmlAlignmentLimits,
};
