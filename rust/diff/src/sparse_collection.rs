// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Fingerprint collection slots. Absent array indices are content (#8042).
use serde::{Deserialize, Deserializer};

/// A projected array slot; a hole is distinct from every present record.
#[derive(Debug, Clone, PartialEq)]
pub enum Slot<T> { Hole, Present(T) }

/// Retains cardinality while canonical sorting moves holes after records.
#[derive(Debug, Clone, PartialEq)]
pub struct SparseCollection<T>(pub Vec<Slot<T>>);
impl<T> Default for SparseCollection<T> {
    fn default() -> Self { Self(Vec::new()) }
}
impl<T> SparseCollection<T> {
    pub fn present(&self) -> impl Iterator<Item = &T> {
        self.0.iter().filter_map(|slot| match slot { Slot::Present(value) => Some(value), Slot::Hole => None })
    }
    pub fn holes(&self) -> usize {
        self.0.iter().filter(|slot| matches!(slot, Slot::Hole)).count()
    }
    pub fn map<U>(self, mut project: impl FnMut(T) -> U) -> SparseCollection<U> {
        SparseCollection(self.0.into_iter().map(|slot| match slot {
            Slot::Hole => Slot::Hole, Slot::Present(value) => Slot::Present(project(value)),
        }).collect())
    }
}
impl<T> FromIterator<T> for SparseCollection<T> {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
        Self(iter.into_iter().map(Slot::Present).collect())
    }
}
impl<T> From<Vec<T>> for SparseCollection<T> {
    fn from(values: Vec<T>) -> Self { values.into_iter().collect() }
}
// Serialized forms (JSON, document DTOs) cannot express an absent array index:
// a `null` element is a PRESENT value, which the TypeScript oracle rejects when
// it reads `.name` (#8114). So decoding is dense and `null` fails in the record
// decoder; only the raw host decoder, which can see the array, constructs holes.
impl<'de, T: Deserialize<'de>> Deserialize<'de> for SparseCollection<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<T>::deserialize(deserializer).map(Self::from)
    }
}
pub(crate) fn optional_sparse<'de, D, T>(deserializer: D) -> Result<SparseCollection<T>, D::Error>
where D: Deserializer<'de>, T: Deserialize<'de> {
    Option::<SparseCollection<T>>::deserialize(deserializer).map(Option::unwrap_or_default)
}
