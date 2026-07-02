// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Document association extraction.

use super::types::{DocumentAssociation, EntityJob};
use ifc_lite_core::EntityDecoder;
use rayon::prelude::*;
use std::sync::Arc;

/// Resolve an `IfcDocumentReference` / `IfcDocumentInformation` into
/// `(identification, name, location, description)`.
fn resolve_document(
    decoder: &mut EntityDecoder,
    id: u32,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let Ok(entity) = decoder.decode_by_id(id) else {
        return (None, None, None, None);
    };
    let ty = entity.ifc_type.as_str().to_ascii_uppercase();

    if ty == "IFCDOCUMENTINFORMATION" {
        // Identification(0), Name(1), Description(2), Location(3).
        return (
            entity.get_string(0).map(|s| s.to_string()),
            entity.get_string(1).map(|s| s.to_string()),
            entity.get_string(3).map(|s| s.to_string()),
            entity.get_string(2).map(|s| s.to_string()),
        );
    }

    // IfcDocumentReference: Location(0), Identification(1), Name(2),
    // Description(3), ReferencedDocument(4).
    let mut location = entity.get_string(0).map(|s| s.to_string());
    let mut identification = entity.get_string(1).map(|s| s.to_string());
    let mut name = entity.get_string(2).map(|s| s.to_string());
    let mut description = entity.get_string(3).map(|s| s.to_string());

    // Backfill missing fields from the referenced IfcDocumentInformation.
    if let Some(info_id) = entity.get_ref(4) {
        if let Ok(info) = decoder.decode_by_id(info_id) {
            if info
                .ifc_type
                .as_str()
                .eq_ignore_ascii_case("IFCDOCUMENTINFORMATION")
            {
                identification =
                    identification.or_else(|| info.get_string(0).map(|s| s.to_string()));
                name = name.or_else(|| info.get_string(1).map(|s| s.to_string()));
                description = description.or_else(|| info.get_string(2).map(|s| s.to_string()));
                location = location.or_else(|| info.get_string(3).map(|s| s.to_string()));
            }
        }
    }

    (identification, name, location, description)
}

/// Extract document associations (`IfcRelAssociatesDocument`).
pub(super) fn extract_documents(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<DocumentAssociation> {
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.type_name
                .eq_ignore_ascii_case("IFCRELASSOCIATESDOCUMENT")
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting documents");

    rel_jobs
        .par_iter()
        .flat_map(|job| {
            let mut decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let Ok(rel) = decoder.decode_at(job.start, job.end) else {
                return Vec::new();
            };
            let related = super::related_object_ids(&rel);
            // RelatingDocument is attribute 5.
            let Some(doc_id) = rel.get_ref(5) else {
                return Vec::new();
            };
            let (identification, name, location, description) =
                resolve_document(&mut decoder, doc_id);

            related
                .into_iter()
                .map(|element_id| DocumentAssociation {
                    element_id,
                    identification: identification.clone(),
                    name: name.clone(),
                    location: location.clone(),
                    description: description.clone(),
                })
                .collect()
        })
        .collect()
}
