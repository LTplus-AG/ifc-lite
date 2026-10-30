// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Fingerprint collection slots. Absent array indices are content (#8042).
use serde::{Deserialize, Deserializer};

/// A projected array slot; a hole is distinct from every present record.
#[derive(Debug, Clone, PartialEq)]
pub enum Slot<T> { Hole, Present(T) }

/// Present records in input order plus a hole COUNT (#8042, #8114).
///
/// Canonical sorting moves every hole after the records, and the stable sort
/// keeps the present records' relative order whatever the hole positions, so
/// positions are not content: equality ignores them. Counting instead of
/// storing keeps memory O(present) for any array length, including a valid
/// 2^32 - 1 slot array, while cardinality stays exact.
#[derive(Debug, Clone, PartialEq)]
pub struct SparseCollection<T> { present: Vec<T>, holes: usize }
impl<T> Default for SparseCollection<T> {
    fn default() -> Self { Self { present: Vec::new(), holes: 0 } }
}
impl<T> SparseCollection<T> {
    pub fn present(&self) -> impl Iterator<Item = &T> { self.present.iter() }
    pub fn holes(&self) -> usize { self.holes }
    pub fn push(&mut self, value: T) { self.present.push(value); }
    /// Add `count` holes in O(1).
    pub fn push_holes(&mut self, count: usize) {
        self.holes = self.holes.checked_add(count).expect("sparse hole count exceeds usize");
    }
    pub fn map<U>(self, project: impl FnMut(T) -> U) -> SparseCollection<U> {
        SparseCollection { present: self.present.into_iter().map(project).collect(), holes: self.holes }
    }
}
impl<T> FromIterator<T> for SparseCollection<T> {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
        Self { present: iter.into_iter().collect(), holes: 0 }
    }
}
impl<T> FromIterator<Slot<T>> for SparseCollection<T> {
    fn from_iter<I: IntoIterator<Item = Slot<T>>>(iter: I) -> Self {
        let mut collection = Self::default();
        for slot in iter {
            match slot { Slot::Hole => collection.push_holes(1), Slot::Present(value) => collection.push(value) }
        }
        collection
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
