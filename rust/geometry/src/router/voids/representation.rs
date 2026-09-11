// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Conservative, geometry-free routing for documented Reference openings.
use crate::GeometryRouter;
use ifc_lite_core::{EntityDecoder, IfcType};

impl GeometryRouter {
    /// Whether an opening must retain the canonical cutter path. Only a proven
    /// Reference-only opening (optionally with BoundingBox) returns false.
    /// Unknown, malformed, empty and over-budget representation data returns true
    /// so ordinary cutter/error handling remains authoritative (#4440).
    pub fn opening_requires_subtraction(&self, id:u32, decoder:&mut EntityDecoder<'_>)->bool {
        let reference_only=(|| {
            let opening=decoder.decode_by_id(id).ok()?;
            if !opening.ifc_type.is_subtype_of(IfcType::IfcOpeningElement) {return None;}
            let pds=decoder.decode_by_id(opening.get_ref(6)?).ok()?;
            if pds.ifc_type!=IfcType::IfcProductDefinitionShape {return None;}
            let representations=pds.get_list(2)?;
            if representations.is_empty() || representations.len()>64 {return None;}
            let mut reference=false;
            for value in representations {
                let representation=decoder.decode_by_id(value.as_entity_ref()?).ok()?;
                if representation.ifc_type!=IfcType::IfcShapeRepresentation {return None;}
                match crate::router::effective_element_rep_type(&opening,&representation) {
                    Some("Reference")=>reference=true,
                    Some("BoundingBox")=>{},
                    _=>return None,
                }
            }
            Some(reference)
        })();
        reference_only!=Some(true)
    }
}
