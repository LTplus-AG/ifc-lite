// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Product-scoped polygonal annotation fills (#4406). Deliberately not a
//! registry processor: type-level FootPrint/Annotation maps must remain absent.
use super::GeometryRouter;
use crate::{Error, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

pub(crate) fn accepts(product: &DecodedEntity, rep_type: &str) -> bool {
    product.ifc_type == IfcType::IfcAnnotation && matches!(rep_type, "Annotation2D" | "Surface2D")
}

/// Whether `shape_rep` reaches the mesher only for its fill areas: an
/// annotation's own `Annotation2D` / `Surface2D` representation, admitted by
/// [`accepts`] (never a body type). Its other items (curve sets, polylines,
/// text literals) are symbolic: the symbolic-annotation layer draws them and
/// no mesh processor exists for them, so walking them only counted each one as
/// a dropped item and warned "missing or incomplete" on a clean model (#5389).
pub(crate) fn is_fill_only_representation(product: &DecodedEntity, shape_rep: &DecodedEntity) -> bool {
    crate::representation::effective_element_rep_type(product, shape_rep)
        .is_some_and(|rep_type| accepts(product, rep_type))
}

impl GeometryRouter {
    pub(crate) fn process_annotation_fill(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        let result = (|| {
            crate::program::annotation::AnnotationFill::admit(item, decoder, self.unit_scale())?.evaluate()
        })();
        if result.is_err() {
            self.record_unsupported_item(item.ifc_type.clone());
        }
        result
    }
}

pub(crate) fn invalid(reason: &str) -> Error {
    Error::geometry(format!("IfcAnnotationFillArea: {reason}"))
}
