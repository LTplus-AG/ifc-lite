// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Classification association extraction.

use super::types::{ClassificationAssociation, EntityJob};
use ifc_lite_core::EntityDecoder;
use rayon::prelude::*;
use std::sync::Arc;

/// Resolve an `IfcClassificationReference` / `IfcClassification` into
/// `(identification, name, location, system_name)`. Walks `ReferencedSource`
/// up to the owning `IfcClassification` (bounded to avoid cycles).
fn resolve_classification(
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

    if entity
        .ifc_type
        .as_str()
        .eq_ignore_ascii_case("IFCCLASSIFICATION")
    {
        // Directly an IfcClassification: Name is attribute 3.
        return (
            None,
            None,
            None,
            entity.get_string(3).map(|s| s.to_string()),
        );
    }

    // IfcClassificationReference: Location(0), Identification(1), Name(2),
    // ReferencedSource(3).
    let location = entity.get_string(0).map(|s| s.to_string());
    let identification = entity.get_string(1).map(|s| s.to_string());
    let name = entity.get_string(2).map(|s| s.to_string());

    // Walk ReferencedSource up to the IfcClassification for the system name.
    let mut system_name = None;
    let mut source = entity.get_ref(3);
    let mut depth = 0;
    while let Some(src_id) = source {
        if depth >= 8 {
            break;
        }
        depth += 1;
        let Ok(src) = decoder.decode_by_id(src_id) else {
            break;
        };
        if src
            .ifc_type
            .as_str()
            .eq_ignore_ascii_case("IFCCLASSIFICATION")
        {
            system_name = src.get_string(3).map(|s| s.to_string());
            break;
        }
        // Another IfcClassificationReference — keep walking its ReferencedSource.
        source = src.get_ref(3);
    }

    (identification, name, location, system_name)
}

/// Extract classification associations (`IfcRelAssociatesClassification`).
pub(super) fn extract_classifications(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<ClassificationAssociation> {
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.type_name
                .eq_ignore_ascii_case("IFCRELASSOCIATESCLASSIFICATION")
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting classifications");

    rel_jobs
        .par_iter()
        .flat_map(|job| {
            let mut decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let Ok(rel) = decoder.decode_at(job.start, job.end) else {
                return Vec::new();
            };
            let related = super::related_object_ids(&rel);
            // RelatingClassification is attribute 5.
            let Some(class_id) = rel.get_ref(5) else {
                return Vec::new();
            };
            let (identification, name, location, system_name) =
                resolve_classification(&mut decoder, class_id);

            related
                .into_iter()
                .map(|element_id| ClassificationAssociation {
                    element_id,
                    system_name: system_name.clone(),
                    identification: identification.clone(),
                    name: name.clone(),
                    location: location.clone(),
                })
                .collect()
        })
        .collect()
}
