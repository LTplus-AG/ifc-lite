/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::parse_landxml_tin;
use crate::{xml::Result, LandXmlDiagnosticCode as Code, LandXmlTinDocument};

/// Parse the canonical LandXML source document used by all runtime adapters.
///
/// TIN and pipe semantics deliberately keep their specialised bounded parsers,
/// but consumers receive one document and therefore cannot accidentally load
/// pipe records through a second ingestion path.
pub(crate) fn parse_landxml_document(input: &[u8]) -> Result<LandXmlTinDocument> {
    let mut document = parse_landxml_tin(input)?;
    match crate::parse_landxml_pipe_networks(input) {
        Ok(networks) => document.pipe_networks = Some(networks),
        Err(error)
            if error.code == Code::InvalidSemantic
                && error.message == "document contains no PipeNetwork records" => {}
        Err(error) => return Err(error),
    }
    Ok(document)
}
