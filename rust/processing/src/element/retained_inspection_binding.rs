// SPDX-License-Identifier: MPL-2.0
//! Identities derive from immutable source and options, never product metadata.
use super::*;
use sha2::{Digest, Sha256};

pub(super) fn from_source(source: &SourceBundle, root: &DecodedEntity, options: &wire::Options, revision: u64)
    -> Result<wire::Binding, RetainedInspectionError> {
    let global_id = match root.attr(0) {
        None | Some(ifc_lite_core::AttributeValue::Null) => wire::GlobalIdentity::Absent(Box::new(wire::AbsentGlobalId {})),
        Some(value) => {
            let value = value.as_string().ok_or_else(RetainedInspectionError::invalid_source)?;
            wire::check_global_id(value).map_err(|_| RetainedInspectionError::invalid_source())?;
            wire::GlobalIdentity::Known(Box::new(wire::KnownGlobalId { value: value.into() }))
        }
    };
    let mut hash = Sha256::new();
    // Cooperative source hashing: at most 64 KiB between original-clock checks.
    for bytes in source.bytes().chunks(64 * 1024) {
        checkpoint("hash_chunk")?;
        resource::charge(Cost { work: 1, ..Default::default() }).map_err(RetainedInspectionError::stopped)?;
        hash.update(bytes);
    }
    checkpoint("hash_done")?;
    let sha256 = format!("{:x}", hash.finalize());
    let namespace = format!("{:x}", Sha256::digest(format!("ifc-lite/source-inspection/v1/{sha256}")));
    let source = wire::Source { namespace, revision: revision.to_string(), sha256 };
    let canonical = serde_json::to_vec(&(&source, options)).map_err(|_| RetainedInspectionError::invalid_options())?;
    let result_id = format!("{:x}", Sha256::digest(canonical));
    Ok(wire::Binding {
        identity: wire::Identity { schema_version: 1., coverage_version: 1., engine: "retained".into(),
            source, options: options.clone(), result_id },
        // One selected product is not an exhaustive model enumeration.
        enumeration_complete: false, non_geometric: Vec::new(),
        requested: vec![wire::ProductKey { product_id: root.id.to_string(), global_id }],
    })
}
