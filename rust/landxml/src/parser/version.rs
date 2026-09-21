/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

pub const LANDXML_10_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.0";
pub const LANDXML_11_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.1";
pub const LANDXML_12_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.2";

/// Classify known LandXML roots without relaxing the strict 1.2 ingest policy.
pub fn classify_landxml_version(
    namespace: Option<&str>,
    version: Option<&str>,
) -> crate::LandXmlVersionCapability {
    use crate::LandXmlVersionCapability as Capability;
    match namespace {
        Some(LANDXML_10_NAMESPACE) => Capability::LandXml10Unsupported,
        Some(LANDXML_11_NAMESPACE) => Capability::LandXml11Unsupported,
        Some(LANDXML_12_NAMESPACE) if version == Some("1.2") => Capability::LandXml12Tin,
        Some(LANDXML_12_NAMESPACE) => Capability::LandXml12VersionMismatch,
        _ => Capability::NotLandXml,
    }
}
