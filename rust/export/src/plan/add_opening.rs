// SPDX-License-Identifier: MPL-2.0
//! The opening an Add cuts into a host, and the fill when the new object is
//! a door or window. A child of `add`.

use crate::plan::add_geometry::product_shape;
use crate::plan::add_types::{GlobalId, NewOpening, Representation};
use crate::plan::attrs::attribute_index;
use crate::plan::tessellation::Emit;

use super::AddState;

impl AddState<'_> {
    /// An `IfcOpeningElement` cut into `host` at `op`, in the new object's
    /// frame, voiding the host and, for a door or window, filled by it.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build_opening(
        &self,
        emit: &mut Emit,
        gid: GlobalId,
        host: u32,
        op: &NewOpening,
        ctx: u32,
        placement: u32,
        (object, fills): (u32, bool),
        owner_history: u32,
    ) -> Result<(), String> {
        let owh = format!("#{owner_history}");
        let guid = |role: &str| format!("'{}'", gid.derive(role).encode());
        let a2p = emit.axis_placement(&op.matrix)?;
        let op_placement = emit.record(
            "IFCLOCALPLACEMENT",
            &[("PlacementRelTo", format!("#{placement}")), ("RelativePlacement", format!("#{a2p}"))],
        )?;
        let op_shape = product_shape(emit, ctx, &Representation::Extrusion(op.shape.clone()), None)?.ok_or("opening shape")?;
        let mut fields = vec![
            ("GlobalId", guid("opening")),
            ("OwnerHistory", owh.clone()),
            ("Name", "'Opening'".into()),
            ("ObjectPlacement", format!("#{op_placement}")),
            ("Representation", format!("#{op_shape}")),
        ];
        if attribute_index(self.schema, "IFCOPENINGELEMENT", "PredefinedType").is_some() {
            fields.push(("PredefinedType", ".OPENING.".into()));
        }
        let opening = emit.record("IFCOPENINGELEMENT", &fields)?;
        emit.record(
            "IFCRELVOIDSELEMENT",
            &[
                ("GlobalId", guid("rel/voids")),
                ("OwnerHistory", owh.clone()),
                ("RelatingBuildingElement", format!("#{host}")),
                ("RelatedOpeningElement", format!("#{opening}")),
            ],
        )?;
        if fills {
            emit.record(
                "IFCRELFILLSELEMENT",
                &[
                    ("GlobalId", guid("rel/fills")),
                    ("OwnerHistory", owh),
                    ("RelatingOpeningElement", format!("#{opening}")),
                    ("RelatedBuildingElement", format!("#{object}")),
                ],
            )?;
        }
        Ok(())
    }
}
