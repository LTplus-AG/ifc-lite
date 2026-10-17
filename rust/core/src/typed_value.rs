// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Typed STEP parameters (`IFCLABEL('x')`, `IFCPARAMETERVALUE(0.5)`) and
//! STEP LOGICAL enumerations (`.T.`, `.F.`, `.U.`), read through one home
//! (F3c, #7776).
//!
//! Before F3c a typed parameter decoded to `List([String(TYPE), value])`, a
//! shape a genuine two-item string list (`IfcPerson.MiddleNames
//! ('Anne','Marie')`) shares, so a dozen readers each guessed at the
//! difference. [`AttributeValue::Typed`] is a variant of its own; the readers
//! here see through it, and nothing else does.

use crate::schema_gen::{AttributeValue, DecodedEntity};

/// A STEP LOGICAL: `.T.`, `.F.` or the third value, `.U.` (unknown). A
/// BOOLEAN attribute is the same enumeration without the third value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Logical {
    True,
    False,
    /// `.U.`, and `.X.`, the spelling some authoring tools write for it.
    Unknown,
}

impl Logical {
    /// `Some` for a definite value, `None` for [`Logical::Unknown`].
    #[inline]
    pub fn to_bool(self) -> Option<bool> {
        match self {
            Logical::True => Some(true),
            Logical::False => Some(false),
            Logical::Unknown => None,
        }
    }
}

impl AttributeValue {
    /// A typed parameter as its type name (upper-case, the EXPRESS spelling)
    /// and value. `None` for everything else, a list of strings included.
    #[inline]
    pub fn as_typed(&self) -> Option<(&str, &AttributeValue)> {
        match self {
            AttributeValue::Typed { name, value } => Some((name, value)),
            _ => None,
        }
    }

    /// The value inside any typed wrapper, or `self` when it is not typed.
    #[inline]
    pub fn unwrap_typed(&self) -> &AttributeValue {
        let mut value = self;
        while let AttributeValue::Typed { value: inner, .. } = value {
            value = inner;
        }
        value
    }

    /// The value of a typed parameter named `name` (ASCII-case-insensitive),
    /// `None` for any other value: `typed_value("IFCPARAMETERVALUE")`.
    #[inline]
    pub fn typed_value(&self, name: &str) -> Option<&AttributeValue> {
        match self.as_typed() {
            Some((n, value)) if n.eq_ignore_ascii_case(name) => Some(value),
            _ => None,
        }
    }

    /// This value as a STEP LOGICAL, seeing through a typed wrapper
    /// (`IFCBOOLEAN(.T.)`). `.U.` and `.X.` are [`Logical::Unknown`]; a
    /// `$`, `*`, a non-enumeration and any other enumeration are `None`.
    ///
    /// The tokenizer strips the dots, so the stored text is `T`, not `.T.`.
    /// `TRUE` and `FALSE` are read too, as the readers this replaced did.
    #[inline]
    pub fn as_logical(&self) -> Option<Logical> {
        match self {
            AttributeValue::Enum(e) => match e.as_str() {
                "T" | "TRUE" => Some(Logical::True),
                "F" | "FALSE" => Some(Logical::False),
                "U" | "X" => Some(Logical::Unknown),
                _ => None,
            },
            AttributeValue::Typed { value, .. } => value.as_logical(),
            _ => None,
        }
    }

    /// This value as a definite boolean: `.T.` or `.F.`. `None` for `.U.`,
    /// `$`, `*` and everything else, so a caller states its own default with
    /// `unwrap_or`.
    #[inline]
    pub fn as_bool(&self) -> Option<bool> {
        self.as_logical().and_then(Logical::to_bool)
    }
}

impl DecodedEntity {
    /// Get a STEP LOGICAL attribute (see [`AttributeValue::as_logical`]).
    #[inline]
    pub fn get_logical(&self, index: usize) -> Option<Logical> {
        self.get(index).and_then(AttributeValue::as_logical)
    }

    /// Get a definite boolean attribute: `None` for `.U.`, `$` and a missing
    /// or non-boolean value. `get_bool(i).unwrap_or(default)` is the one way
    /// to read a flag; the default is the caller's policy.
    #[inline]
    pub fn get_bool(&self, index: usize) -> Option<bool> {
        self.get(index).and_then(AttributeValue::as_bool)
    }

    /// Get an enumeration attribute, seeing through a typed wrapper.
    #[inline]
    pub fn get_enum(&self, index: usize) -> Option<&str> {
        self.get(index).and_then(AttributeValue::as_enum)
    }

    /// Get an integer attribute (see [`AttributeValue::as_int`]).
    #[inline]
    pub fn get_int(&self, index: usize) -> Option<i64> {
        self.get(index).and_then(AttributeValue::as_int)
    }
}

#[cfg(test)]
#[path = "typed_value_tests.rs"]
mod tests;
