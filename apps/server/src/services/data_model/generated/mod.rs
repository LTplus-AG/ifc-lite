// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Generated tables for the data-model service (see the sibling files'
//! headers for their generator scripts).

mod attr_indices;
pub use attr_indices::{root_attr_indices, RootAttrIndices};

mod relationship_slots;
pub use relationship_slots::{relationship_slots, RelationshipSlots};

// C6-4 deletes this module with the two tables above; the test goes with it,
// having proved core's registry lookup row-for-row first.
#[cfg(test)]
mod core_lookup_equality_tests;
