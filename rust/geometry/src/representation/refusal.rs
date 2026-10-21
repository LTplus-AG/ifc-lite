// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Why the walk declined to enter, or to continue past, a mapped item. All
/// but the items of an entered level are refused before `enter_map`.
#[derive(Debug)]
pub enum WalkRefusal {
    /// The mapped item is already on the path.
    Cyclic,
    /// The depth cap, or a nested map under [`super::NestedMaps::Refuse`].
    TooDeep { max_depth: u32 },
    /// The `IfcMappedItem` has no `MappingSource` attribute.
    MissingSource,
    /// `MappingSource` does not resolve.
    UnresolvedSource,
    /// The map has no `MappedRepresentation` attribute.
    MissingMappedRepresentation,
    /// `MappedRepresentation` does not resolve.
    UnresolvedMappedRepresentation,
    /// The mapped representation has no `Items` attribute.
    MissingItems,
    /// The mapped-level or total Items-member allowance was exhausted.
    Budget { max_levels: u32 },
    /// The decoder failed on one of the references.
    Decode(ifc_lite_core::Error),
}

impl WalkRefusal {
    /// The error the strict callers have always reported for this refusal,
    /// with its exact message text; `item` is the refused `IfcMappedItem`'s id.
    pub fn into_error(self, item: u32) -> crate::Error {
        let msg = match self {
            WalkRefusal::Cyclic => format!("Detected cyclic IfcMappedItem reference at #{item}"),
            WalkRefusal::TooDeep { max_depth } => format!(
                "MappedItem nesting exceeded maximum depth of {max_depth} at #{item}"
            ),
            WalkRefusal::Budget { max_levels } => format!(
                "IfcMappedItem expansion exceeded the work budget of {max_levels} levels or item references at #{item}"
            ),
            WalkRefusal::MissingSource => "MappedItem missing MappingSource".to_string(),
            WalkRefusal::UnresolvedSource => "Failed to resolve MappingSource".to_string(),
            WalkRefusal::MissingMappedRepresentation => {
                "RepresentationMap missing MappedRepresentation".to_string()
            }
            WalkRefusal::UnresolvedMappedRepresentation => {
                "Failed to resolve MappedRepresentation".to_string()
            }
            WalkRefusal::MissingItems => "Representation missing Items".to_string(),
            WalkRefusal::Decode(error) => return crate::Error::CoreError(error),
        };
        crate::Error::geometry(msg)
    }
}
