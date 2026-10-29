// SPDX-License-Identifier: MPL-2.0
//! The product an Add is nested in: checked against the schema, then tied
//! through `IfcRelNests` or, for an IFC2X3 port, `IfcRelConnectsPortToElement`.
//! A child of `add`.

use crate::plan::add_rels::{RelKind, RelRequest};
use crate::plan::add_types::GlobalId;
use crate::plan::tessellation::Emit;
use crate::plan::types::ObjectRef;

use super::AddState;

/// How a new object is tied to the product it is nested in.
#[derive(Clone, Copy)]
pub(super) enum Nest {
    /// `IfcRelNests`, with the host as `RelatingObject`.
    Nested,
    /// `IfcRelConnectsPortToElement`, IFC2X3's tie from a port to its element.
    PortOf,
}

impl AddState<'_, '_> {
    /// `r`'s id, how a new `class` is tied to it, and `r`'s class. A spatial
    /// structure element is refused: its decomposition is its aggregation.
    pub(super) fn check_nest(&self, r: &ObjectRef, class: &str, spatial: bool) -> Result<(u32, Nest, String), String> {
        if spatial {
            return Err(format!("a new {class} is aggregated into its container and cannot also be nested"));
        }
        let (id, host) = self.lookup(r)?;
        if !self.is_a(&host, "IFCPRODUCT") {
            return Err(format!("nesting host {r} is {host}, not a product"));
        }
        if !crate::schema_convert::targets_ifc2x3(self.schema) {
            return Ok((id, Nest::Nested, host));
        }
        // IFC2X3's IfcRelNests WR1: every related object is of the relating
        // object's own class.
        let nest = if self.is_a(class, "IFCPORT") {
            if !self.is_a(&host, "IFCELEMENT") {
                return Err(format!("nesting host {r} is {host}: IFC2X3 connects a port only to an element"));
            }
            Nest::PortOf
        } else if host == class {
            Nest::Nested
        } else {
            return Err(format!("nesting host {r} is {host}: IFC2X3 nests a {class} only under another {class}"));
        };
        Ok((id, nest, host))
    }
}

/// Tie `object` to `host`: an `IfcRelNests` request, gathered with the other
/// Adds' like containment, or an `IfcRelConnectsPortToElement`, which relates
/// one port to one element and so is written here.
pub(super) fn nest_object(emit: &mut Emit, (host, nest): (u32, Nest), object: u32, gid: GlobalId, owh: &str, requests: &mut Vec<RelRequest>) -> Result<(), String> {
    match nest {
        Nest::Nested => requests.push(RelRequest { kind: RelKind::Nests, relating: host, related: object, seed: gid }),
        Nest::PortOf => {
            emit.record(
                "IFCRELCONNECTSPORTTOELEMENT",
                &[
                    ("GlobalId", format!("'{}'", gid.derive("rel/port").encode())),
                    ("OwnerHistory", owh.to_string()),
                    ("RelatingPort", format!("#{object}")),
                    ("RelatedElement", format!("#{host}")),
                ],
            )?;
        }
    }
    Ok(())
}
