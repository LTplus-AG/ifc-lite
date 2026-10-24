// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Scalar map keys follow serde_json 1.0.154's ser.rs MapKeySerializer.
//! Keep integers out of DocumentValue::Number: key text must not round via f64.
use crate::{
    document_ser::DocumentSerializer,
    document_serde::{error, Error, STRING},
    DocumentValue, JsString,
};
use serde::{ser::Impossible, Serialize, Serializer};

pub(crate) struct KeySerializer;
macro_rules! scalar {
    ($method:ident, $ty:ty) => {
        fn $method(self, value: $ty) -> Result<JsString, Error> {
            Ok(value.to_string().into())
        }
    };
}
macro_rules! float {
    ($method:ident, $ty:ty) => {
        fn $method(self, value: $ty) -> Result<JsString, Error> {
            if !value.is_finite() {
                return Err(error("float key must be finite"));
            }
            // Use the pinned JSON formatter, including f32 precision and -0.0.
            Ok(serde_json::to_string(&value)?.into())
        }
    };
}
fn invalid_key() -> Error {
    error("key must be a string")
}
impl Serializer for KeySerializer {
    type Ok = JsString;
    type Error = Error;
    type SerializeSeq = Impossible<JsString, Error>;
    type SerializeTuple = Impossible<JsString, Error>;
    type SerializeTupleStruct = Impossible<JsString, Error>;
    type SerializeTupleVariant = Impossible<JsString, Error>;
    type SerializeMap = Impossible<JsString, Error>;
    type SerializeStruct = Impossible<JsString, Error>;
    type SerializeStructVariant = Impossible<JsString, Error>;

    fn is_human_readable(&self) -> bool {
        false
    }
    scalar!(serialize_bool, bool);
    scalar!(serialize_i8, i8);
    scalar!(serialize_i16, i16);
    scalar!(serialize_i32, i32);
    scalar!(serialize_i64, i64);
    scalar!(serialize_i128, i128);
    scalar!(serialize_u8, u8);
    scalar!(serialize_u16, u16);
    scalar!(serialize_u32, u32);
    scalar!(serialize_u64, u64);
    scalar!(serialize_u128, u128);
    scalar!(serialize_char, char);
    float!(serialize_f32, f32);
    float!(serialize_f64, f64);
    fn serialize_str(self, value: &str) -> Result<JsString, Error> {
        Ok(value.into())
    }
    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
    ) -> Result<JsString, Error> {
        self.serialize_str(variant)
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        name: &'static str,
        value: &T,
    ) -> Result<JsString, Error> {
        if name == STRING {
            // Only the typed lossless-string marker admits a unit sequence.
            return match DocumentSerializer.serialize_newtype_struct(name, value)? {
                DocumentValue::String(key) => Ok(key),
                _ => Err(invalid_key()),
            };
        }
        value.serialize(self)
    }
    fn serialize_bytes(self, _: &[u8]) -> Result<JsString, Error> {
        Err(invalid_key())
    }
    fn serialize_none(self) -> Result<JsString, Error> {
        Err(invalid_key())
    }
    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<JsString, Error> {
        // Text JSON unwraps Some keys; serde_json::to_value rejects them.
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<JsString, Error> {
        Err(invalid_key())
    }
    fn serialize_unit_struct(self, _: &'static str) -> Result<JsString, Error> {
        Err(invalid_key())
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: &T,
    ) -> Result<JsString, Error> {
        Err(invalid_key())
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, Error> {
        Err(invalid_key())
    }
    fn serialize_tuple(self, _: usize) -> Result<Self::SerializeTuple, Error> {
        Err(invalid_key())
    }
    fn serialize_tuple_struct(
        self,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeTupleStruct, Error> {
        Err(invalid_key())
    }
    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeTupleVariant, Error> {
        Err(invalid_key())
    }
    fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Error> {
        Err(invalid_key())
    }
    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Self::SerializeStruct, Error> {
        Err(invalid_key())
    }
    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeStructVariant, Error> {
        Err(invalid_key())
    }
}
