// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One non-finite policy for every JSON document this module hands to Python
//! (#7679, EDGE-FFI-5).
//!
//! `serde_json` writes NaN and the infinities as `null`, so a Python caller
//! that expects a `float` receives `None`. Rather than a hand-written walker
//! per payload type (the rebar schedule had one), the document is first walked
//! by a [`Probe`], a discarding `serde::Serializer` that fails on the first
//! non-finite `f32`/`f64` and names where it is. Every JSON entry point goes
//! through [`to_json_string`] or [`ensure_finite`].

use std::fmt;

use pyo3::exceptions::PyValueError;
use pyo3::PyResult;
use serde::ser::{self, Serialize};

/// A non-finite float found while serialising, with its location.
#[derive(Debug, PartialEq)]
pub(crate) struct NonFinite(String);

impl fmt::Display for NonFinite {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NonFinite {}

impl ser::Error for NonFinite {
    fn custom<T: fmt::Display>(msg: T) -> Self {
        NonFinite(msg.to_string())
    }
}

/// Fail on the first NaN or infinity anywhere in `value`.
pub(crate) fn ensure_finite<T: Serialize + ?Sized>(value: &T) -> Result<(), NonFinite> {
    value.serialize(&mut Probe::default())
}

/// `serde_json::to_string`, refusing a document with a non-finite float
/// instead of writing `null` for it.
pub(crate) fn to_json_string<T: Serialize + ?Sized>(value: &T) -> PyResult<String> {
    ensure_finite(value).map_err(|e| PyValueError::new_err(e.to_string()))?;
    serde_json::to_string(value).map_err(|e| PyValueError::new_err(e.to_string()))
}

#[derive(Default)]
struct Probe {
    path: Vec<String>,
}

impl Probe {
    fn float(&self, v: f64) -> Result<(), NonFinite> {
        if v.is_finite() {
            return Ok(());
        }
        let mut at = String::new();
        for segment in &self.path {
            if !at.is_empty() && !segment.starts_with('[') {
                at.push('.');
            }
            at.push_str(segment);
        }
        if at.is_empty() {
            at.push_str("the document");
        }
        Err(NonFinite(format!("{at} is non-finite ({v}); JSON would write it as null")))
    }

    fn nested<T: Serialize + ?Sized>(&mut self, segment: String, value: &T) -> Result<(), NonFinite> {
        self.path.push(segment);
        let r = value.serialize(&mut *self);
        self.path.pop();
        r
    }
}

/// Every compound shape: elements and fields are probed, nothing is kept.
struct Compound<'a> {
    probe: &'a mut Probe,
    index: usize,
}

impl Compound<'_> {
    fn element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), NonFinite> {
        let segment = format!("[{}]", self.index);
        self.index += 1;
        self.probe.nested(segment, value)
    }
}

macro_rules! scalar {
    ($($name:ident($ty:ty)),* $(,)?) => {
        $(fn $name(self, _: $ty) -> Result<(), NonFinite> { Ok(()) })*
    };
}

impl<'a> ser::Serializer for &'a mut Probe {
    type Ok = ();
    type Error = NonFinite;
    type SerializeSeq = Compound<'a>;
    type SerializeTuple = Compound<'a>;
    type SerializeTupleStruct = Compound<'a>;
    type SerializeTupleVariant = Compound<'a>;
    type SerializeMap = Compound<'a>;
    type SerializeStruct = Compound<'a>;
    type SerializeStructVariant = Compound<'a>;

    scalar!(
        serialize_bool(bool), serialize_i8(i8), serialize_i16(i16), serialize_i32(i32),
        serialize_i64(i64), serialize_i128(i128), serialize_u8(u8), serialize_u16(u16),
        serialize_u32(u32), serialize_u64(u64), serialize_u128(u128), serialize_char(char),
        serialize_str(&str), serialize_bytes(&[u8]),
    );

    fn serialize_f32(self, v: f32) -> Result<(), NonFinite> {
        self.float(f64::from(v))
    }
    fn serialize_f64(self, v: f64) -> Result<(), NonFinite> {
        self.float(v)
    }
    fn serialize_none(self) -> Result<(), NonFinite> {
        Ok(())
    }
    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<(), NonFinite> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<(), NonFinite> {
        Ok(())
    }
    fn serialize_unit_struct(self, _: &'static str) -> Result<(), NonFinite> {
        Ok(())
    }
    fn serialize_unit_variant(self, _: &'static str, _: u32, _: &'static str) -> Result<(), NonFinite> {
        Ok(())
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, _: &'static str, value: &T) -> Result<(), NonFinite> {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<(), NonFinite> {
        self.nested(variant.to_string(), value)
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Compound<'a>, NonFinite> {
        Ok(Compound { probe: self, index: 0 })
    }
    fn serialize_tuple(self, _: usize) -> Result<Compound<'a>, NonFinite> {
        Ok(Compound { probe: self, index: 0 })
    }
    fn serialize_tuple_struct(self, _: &'static str, _: usize) -> Result<Compound<'a>, NonFinite> {
        Ok(Compound { probe: self, index: 0 })
    }
    fn serialize_tuple_variant(self, _: &'static str, _: u32, variant: &'static str, _: usize) -> Result<Compound<'a>, NonFinite> {
        self.path.push(variant.to_string());
        Ok(Compound { probe: self, index: 0 })
    }
    fn serialize_map(self, _: Option<usize>) -> Result<Compound<'a>, NonFinite> {
        Ok(Compound { probe: self, index: 0 })
    }
    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Compound<'a>, NonFinite> {
        Ok(Compound { probe: self, index: 0 })
    }
    fn serialize_struct_variant(self, _: &'static str, _: u32, variant: &'static str, _: usize) -> Result<Compound<'a>, NonFinite> {
        self.path.push(variant.to_string());
        Ok(Compound { probe: self, index: 0 })
    }
}

impl ser::SerializeSeq for Compound<'_> {
    type Ok = ();
    type Error = NonFinite;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), NonFinite> {
        self.element(value)
    }
    fn end(self) -> Result<(), NonFinite> {
        Ok(())
    }
}

impl ser::SerializeTuple for Compound<'_> {
    type Ok = ();
    type Error = NonFinite;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), NonFinite> {
        self.element(value)
    }
    fn end(self) -> Result<(), NonFinite> {
        Ok(())
    }
}

impl ser::SerializeTupleStruct for Compound<'_> {
    type Ok = ();
    type Error = NonFinite;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), NonFinite> {
        self.element(value)
    }
    fn end(self) -> Result<(), NonFinite> {
        Ok(())
    }
}

impl ser::SerializeTupleVariant for Compound<'_> {
    type Ok = ();
    type Error = NonFinite;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), NonFinite> {
        self.element(value)
    }
    fn end(self) -> Result<(), NonFinite> {
        self.probe.path.pop();
        Ok(())
    }
}

impl ser::SerializeMap for Compound<'_> {
    type Ok = ();
    type Error = NonFinite;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, _: &T) -> Result<(), NonFinite> {
        Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), NonFinite> {
        self.probe.nested("{}".to_string(), value)
    }
    fn end(self) -> Result<(), NonFinite> {
        Ok(())
    }
}

impl ser::SerializeStruct for Compound<'_> {
    type Ok = ();
    type Error = NonFinite;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result<(), NonFinite> {
        self.probe.nested(key.to_string(), value)
    }
    fn end(self) -> Result<(), NonFinite> {
        Ok(())
    }
}

impl ser::SerializeStructVariant for Compound<'_> {
    type Ok = ();
    type Error = NonFinite;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result<(), NonFinite> {
        self.probe.nested(key.to_string(), value)
    }
    fn end(self) -> Result<(), NonFinite> {
        self.probe.path.pop();
        Ok(())
    }
}

#[cfg(test)]
#[path = "finite_json_tests.rs"]
mod tests;
