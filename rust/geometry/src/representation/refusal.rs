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
    #[non_exhaustive]
    Budget { max_levels: u32, details: WalkBudgetRefusal },
    /// The decoder failed on one of the references.
    Decode(ifc_lite_core::Error),
}

/// Opaque, cold-allocated work-budget evidence. Its representation is private
/// so future diagnostic fields do not change visitor matches or common Results.
#[derive(Debug)]
pub struct WalkBudgetRefusal(Box<(&'static str, u64)>);

impl WalkBudgetRefusal {
    pub fn budget(&self) -> &'static str { self.0.0 }
    pub fn reached(&self) -> u64 { self.0.1 }
}

// Refusal details must fit within the decoder error this carrier already held.
const _: () = assert!(
    std::mem::size_of::<WalkRefusal>() <= std::mem::size_of::<ifc_lite_core::Error>()
);

impl WalkRefusal {
    #[cold]
    #[inline(never)]
    pub(crate) fn work_budget(max_levels: u32, budget: &'static str, reached: u64) -> Self {
        Self::Budget { max_levels, details: WalkBudgetRefusal(Box::new((budget, reached))) }
    }

    /// Convert to a geometry error, preserving historical strict messages for
    /// existing refusals. `item` is the refused mapped item's id, or the holding
    /// representation's id for a root-list budget refusal.
    pub fn into_error(self, item: u32) -> crate::Error {
        let msg = match self {
            WalkRefusal::Cyclic => format!("Detected cyclic IfcMappedItem reference at #{item}"),
            WalkRefusal::TooDeep { max_depth } => format!(
                "MappedItem nesting exceeded maximum depth of {max_depth} at #{item}"
            ),
            WalkRefusal::Budget { max_levels, .. } => format!(
                "Representation expansion exceeded the work budget of {max_levels} levels or item references at #{item}"
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
