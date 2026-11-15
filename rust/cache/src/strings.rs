// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The interned string table: `StringTable` in `packages/data` and its
//! serializer `sections/strings.ts`.
//!
//! Layout: count u32, offsets u32[count + 1] (cumulative, first is 0), then
//! the UTF-8 bytes back to back.

use std::collections::HashMap;

use crate::buf::Buf;

/// `StringTable.NULL_INDEX` (-1) as the `Uint32Array` cell stores it. The
/// entity `name` column uses it for a STEP `$`, distinct from `''` (#4930).
pub(crate) const NULL_INDEX: u32 = u32::MAX;

pub(crate) struct StringTable {
    strings: Vec<String>,
    index: HashMap<String, u32>,
}

impl StringTable {
    /// Slot 0 is the empty string, as in the TS table. `StringTable.fromArray`
    /// prepends one when it is missing, which would shift every index by one.
    pub(crate) fn new() -> Self {
        let mut index = HashMap::new();
        index.insert(String::new(), 0);
        Self { strings: vec![String::new()], index }
    }

    pub(crate) fn intern(&mut self, value: &str) -> u32 {
        if let Some(existing) = self.index.get(value) {
            return *existing;
        }
        let id = self.strings.len() as u32;
        self.strings.push(value.to_owned());
        self.index.insert(value.to_owned(), id);
        id
    }

    /// `intern(null | undefined)`: the null index, never a slot.
    pub(crate) fn intern_opt(&mut self, value: Option<&str>) -> u32 {
        value.map_or(NULL_INDEX, |value| self.intern(value))
    }

    pub(crate) fn write(&self) -> Vec<u8> {
        let total: usize = self.strings.iter().map(String::len).sum();
        let mut buf = Buf::with_capacity(4 + (self.strings.len() + 1) * 4 + total);
        buf.u32(self.strings.len() as u32);
        let mut running = 0u32;
        for value in &self.strings {
            buf.u32(running);
            running += value.len() as u32;
        }
        buf.u32(running);
        for value in &self.strings {
            buf.bytes(value.as_bytes());
        }
        buf.into_vec()
    }
}

#[cfg(test)]
#[path = "strings_tests.rs"]
mod tests;
