/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

pub const LANDXML_10_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.0";
pub const LANDXML_11_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.1";
pub const LANDXML_12_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.2";

fn is_known_landxml_version(version: Option<&str>) -> bool {
    matches!(version, Some("1.0" | "1.1" | "1.2"))
}

/// Classify a LandXML root by its namespace-selected grammar and declared
/// version provenance. Producers sometimes pair their grammar namespace with
/// another known declaration; retain that declaration and let the caller
/// record an explicit compatibility diagnostic.
pub fn classify_landxml_version(
    namespace: Option<&str>,
    version: Option<&str>,
) -> crate::LandXmlVersionCapability {
    use crate::LandXmlVersionCapability as Capability;
    match namespace {
        Some(LANDXML_10_NAMESPACE) if version == Some("1.0") => Capability::LandXml10Tin,
        Some(LANDXML_10_NAMESPACE) if is_known_landxml_version(version) => {
            Capability::LandXml10VersionMismatch
        }
        Some(LANDXML_10_NAMESPACE) => Capability::LandXml10Unsupported,
        Some(LANDXML_11_NAMESPACE) if version == Some("1.1") => Capability::LandXml11Tin,
        Some(LANDXML_11_NAMESPACE) if is_known_landxml_version(version) => {
            Capability::LandXml11VersionMismatch
        }
        Some(LANDXML_11_NAMESPACE) => Capability::LandXml11Unsupported,
        Some(LANDXML_12_NAMESPACE) if version == Some("1.2") => Capability::LandXml12Tin,
        Some(LANDXML_12_NAMESPACE) if is_known_landxml_version(version) => {
            Capability::LandXml12VersionMismatch
        }
        Some(LANDXML_12_NAMESPACE) => Capability::LandXml12Unsupported,
        _ => Capability::NotLandXml,
    }
}

/// Preserve a producer's known version mismatch as source metadata. The
/// namespace still selects the grammar used to parse descendant QNames.
pub(crate) fn compatibility_version_diagnostic(
    capability: crate::LandXmlVersionCapability,
    version: &str,
) -> Option<crate::LandXmlCapabilityDiagnostic> {
    capability.has_compatibility_version_mismatch().then(|| {
        crate::LandXmlCapabilityDiagnostic {
            code: crate::LandXmlCapabilityDiagnosticCode::SchemaVersionMismatch,
            source_id: None,
            source_path: "LandXML".to_owned(),
            message: format!(
                "{} namespace is parsed as its declared grammar while preserving version=\"{version}\" provenance",
                capability.schema().expect("mismatch capability has a schema"),
            ),
        }
    })
}
