// SPDX-License-Identifier: MPL-2.0
//! Actual bounded controller column; the original extractor denominator is intact.
use super::Product;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::{inspect_retained_source, RetainedSourceInspection};
use serde::{Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[path = "provenance.rs"]
pub(super) mod provenance;

// Immutable inspection intent, independently validated by the production entry.
pub(super) const OPTIONS: &str = r#"{"schemaVersion":1,"chordToleranceMetres":0.001,"angleToleranceRadians":0.1,
"maxWork":"100000","maxBytes":"67108864","deadlineMs":"10000","typeGeometryMode":"suppress_instanced",
"normalPolicy":"source_analytic_v1","instancePolicy":"uncut_mapped_v1","interfacePolicy":"certified_internal_v1",
"openings":"all","layers":"preserve","skipSmallCuts":false,"mergeLayers":false}"#;

pub(super) enum Column {
    // Materialized immediately after its own inspection: the per-report
    // deadline judges that inspection, not how long later rows take.
    Inspected(Vec<u8>),
    DeliveryRefused(String),
    EntryRefused(String),
    Uninspected,
}
impl Serialize for Column {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = match self {
            Self::Inspected(bytes) => serde_json::from_slice::<serde_json::Value>(bytes)
                .map_err(serde::ser::Error::custom)?,
            // Delivery refused at inspection time. Keep this row and the
            // extractor inventory, without aborting the complete census.
            Self::DeliveryRefused(code) => serde_json::json!({"kind":"delivery_refused", "code":
                serde_json::from_str::<serde_json::Value>(code).map_err(serde::ser::Error::custom)?,
                "authority":"diagnostic_only"}),
            Self::EntryRefused(code) => serde_json::json!({"kind":"entry_refused", "code":
                serde_json::from_str::<serde_json::Value>(code).map_err(serde::ser::Error::custom)?,
                "authority":"diagnostic_only"}),
            Self::Uninspected => serde_json::json!({"kind":"uninspected",
                "reason":"implementation_unbound", "authority":"diagnostic_only"}),
        };
        value.serialize(serializer)
    }
}

pub(super) fn inspect(content: &[u8], products: &mut BTreeMap<u32, Product>) {
    let Some(commit) = provenance::implementation_commit() else {
        for product in products.values_mut() { product.controller = Some(Column::Uninspected); }
        return;
    };
    inspect_at(content, products, commit);
}
fn inspect_at(content: &[u8], products: &mut BTreeMap<u32, Product>, commit: &str) {
    let source = SourceBundle::new(content.to_vec());
    for (&id, product) in products {
        // Keep malformed/non-Body/unsupported rows. This probe does not decide
        // the Q0 denominator, nor promote a numerical prefix to whole support.
        let mut decoder = source.decoder();
        let root = decoder.decode_by_id(id).ok();
        product.controller = Some(match inspect_retained_source(source.clone(), id, root.as_ref(), &mut decoder, OPTIONS, commit) {
            Ok(report) => delivered(&report),
            Err(error) => Column::EntryRefused(error.diagnostic_code_json()),
        });
    }
}

fn delivered(report: &RetainedSourceInspection) -> Column {
    match report.bytes() {
        Ok(bytes) => Column::Inspected(bytes.to_vec()),
        Err(error) => Column::DeliveryRefused(error.diagnostic_code_json()),
    }
}

/// Hash the executing binary separately from its compile-time source pin.
pub(super) fn executable_sha256() -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(std::env::current_exe().ok()?).ok()?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 16 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 { return Some(format!("{:x}", hash.finalize())); }
        hash.update(&buffer[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue_7955_controller_column_keeps_non_body_and_malformed_denominator() {
        let bytes = super::super::tests::model("#90=IFCWALL('0000000000000000000090',$,$,$,$,$,$,$);\n#91=IFCWALL('0000000000000000000091',$,$,$,$,$,#999,$);");
        let mut fixture = super::super::census_bytes(bytes.as_bytes());
        let before = fixture.products.len();
        // Fixture identity only: this helper test does not attest a build.
        inspect_at(bytes.as_bytes(), &mut fixture.products, "0000000000000000000000000000000000000000");
        assert_eq!(fixture.products.len(), before);
        assert!(fixture.products.values().all(|product| product.controller.is_some()));
        let inspected = serde_json::to_value(&fixture.products[&13].controller).unwrap();
        assert_eq!(inspected["outcome"]["kind"], "requires_numerical_evaluation");
        let absent = serde_json::to_value(&fixture.products[&90].controller).unwrap();
        assert_eq!(absent["outcome"]["kind"], "traversal_only");
        let malformed = serde_json::to_value(&fixture.products[&91].controller).unwrap();
        assert_eq!(malformed["outcome"]["kind"], "refused");
        assert_eq!(fixture.products[&13].source_admission, "uninspected");
        assert!(!fixture.enumeration_complete);
    }
}

#[cfg(test)]
#[path = "delivery_tests.rs"]
mod delivery_tests;
