// SPDX-License-Identifier: MPL-2.0
//! The modification count the header reports (`delta-modification-ledger.ts`,
//! full-export mode).
//!
//! A host counts as modified when an edit of some kind was NOMINATED for it
//! and the file actually carries it. For the in-place kinds (attribute,
//! georeferencing, retype, positional) nomination happens only where the
//! rewritten line differs, so a full export treats nomination as delivery.
//! Property- and quantity-set edits are settled by EFFECT: a generated
//! replacement (`record_emitted`) or withheld source lines
//! (`record_withheld`), so an edit that changed nothing counts nothing.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Kind {
    Attribute,
    Georeferencing,
    PropertySet,
    QuantitySet,
    Retype,
    Positional,
}

impl Kind {
    fn effect_settled(self) -> bool {
        matches!(self, Kind::PropertySet | Kind::QuantitySet)
    }
}

#[derive(Default)]
pub(crate) struct Ledger {
    nominated: HashMap<Kind, HashSet<u32>>,
    delivered: HashMap<Kind, HashSet<u32>>,
}

impl Ledger {
    pub(crate) fn nominate(&mut self, id: u32, kind: Kind) {
        self.nominated.entry(kind).or_default().insert(id);
        if !kind.effect_settled() {
            self.delivered.entry(kind).or_default().insert(id);
        }
    }

    pub(crate) fn record_emitted(&mut self, id: u32, kind: Kind) {
        self.delivered.entry(kind).or_default().insert(id);
    }

    pub(crate) fn record_withheld(&mut self, id: u32, kind: Kind) {
        self.delivered.entry(kind).or_default().insert(id);
    }

    /// `recordSourceLineDelivery`.
    pub(crate) fn record_line(&mut self, id: u32, delivery: &Delivery) {
        if delivery.attributed {
            self.record_emitted(id, Kind::Attribute);
            self.record_emitted(id, Kind::Georeferencing);
        }
        if delivery.retyped {
            self.record_emitted(id, Kind::Retype);
        }
        if delivery.positional {
            self.record_emitted(id, Kind::Positional);
        }
    }

    /// Distinct entities with at least one delivered nomination.
    pub(crate) fn modified_count(&self) -> usize {
        let mut entities = HashSet::new();
        for (kind, ids) in &self.nominated {
            let delivered = self.delivered.get(kind);
            for id in ids {
                if delivered.is_some_and(|d| d.contains(id)) {
                    entities.insert(*id);
                }
            }
        }
        entities.len()
    }
}

/// Which edit kinds one rewritten source line carries (`SourceLineDelivery`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Delivery {
    pub(crate) attributed: bool,
    pub(crate) retyped: bool,
    pub(crate) positional: bool,
}

/// The ids whose attribute / georeferencing edits a pass may nominate when
/// the line it writes carries them (`InPlaceNominees`).
#[derive(Default)]
pub(crate) struct Nominees {
    pub(crate) attribute: HashSet<u32>,
    pub(crate) georeferencing: HashSet<u32>,
}

impl Nominees {
    /// `nominateDeliveredInPlaceEdits`.
    pub(crate) fn nominate_delivered(&self, ledger: &mut Ledger, id: u32, delivery: &Delivery) {
        if !delivery.attributed {
            return;
        }
        if self.attribute.contains(&id) {
            ledger.nominate(id, Kind::Attribute);
        }
        if self.georeferencing.contains(&id) {
            ledger.nominate(id, Kind::Georeferencing);
        }
    }
}
