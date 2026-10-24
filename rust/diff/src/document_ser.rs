// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Serde's typed string marker is consumed here, never encoded as a user key.
use crate::{DocumentValue as Value, JsString, sidecar_value::ordered_object, document_serde::{Error, error, STRING}};
use serde::{Serialize, Serializer, ser::{self, SerializeSeq}};
pub fn to_document(value: impl Serialize) -> Result<Value, Error> { value.serialize(DocumentSerializer) }
pub struct DocumentSerializer;
impl Serializer for DocumentSerializer {
    type Ok = Value;
    type Error = Error;
    type SerializeSeq = Sequence;
    type SerializeTuple = Sequence;
    type SerializeTupleStruct = Sequence;
    type SerializeTupleVariant = VariantSequence;
    type SerializeMap = Object;
    type SerializeStruct = Object;
    type SerializeStructVariant = VariantObject;
    fn is_human_readable(&self) -> bool { false }
    fn serialize_bool(self, v: bool) -> Result<Value, Error> { Ok(Value::Bool(v)) }
    fn serialize_i8(self, v: i8) -> Result<Value, Error> { self.serialize_f64(v as f64) }
    fn serialize_i16(self, v: i16) -> Result<Value, Error> { self.serialize_f64(v as f64) }
    fn serialize_i32(self, v: i32) -> Result<Value, Error> { self.serialize_f64(v as f64) }
    fn serialize_i64(self, v: i64) -> Result<Value, Error> { self.serialize_f64(v as f64) }
    fn serialize_u8(self, v: u8) -> Result<Value, Error> { self.serialize_f64(v as f64) }
    fn serialize_u16(self, v: u16) -> Result<Value, Error> { self.serialize_f64(v as f64) }
    fn serialize_u32(self, v: u32) -> Result<Value, Error> { self.serialize_f64(v as f64) }
    fn serialize_u64(self, v: u64) -> Result<Value, Error> { self.serialize_f64(v as f64) }
    fn serialize_f32(self, v: f32) -> Result<Value, Error> { self.serialize_f64(v as f64) }
    fn serialize_f64(self, v: f64) -> Result<Value, Error> { Ok(Value::Number(v)) }
    fn serialize_char(self, v: char) -> Result<Value, Error> { self.serialize_str(&v.to_string()) }
    fn serialize_str(self, v: &str) -> Result<Value, Error> { Ok(Value::String(v.into())) }
    fn serialize_bytes(self, v: &[u8]) -> Result<Value, Error> { v.serialize(self) }
    fn serialize_none(self) -> Result<Value, Error> { Ok(Value::Null) }
    fn serialize_some<T: Serialize + ?Sized>(self, v: &T) -> Result<Value, Error> { v.serialize(self) }
    fn serialize_unit(self) -> Result<Value, Error> { Ok(Value::Null) }
    fn serialize_unit_struct(self, _: &'static str) -> Result<Value, Error> { self.serialize_unit() }
    fn serialize_unit_variant(self, _: &'static str, _: u32, variant: &'static str) -> Result<Value, Error> { self.serialize_str(variant) }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, name: &'static str, v: &T) -> Result<Value, Error> {
        let value = v.serialize(self)?;
        if name != STRING { return Ok(value); }
        let Value::Array(values) = value else { return Err(error("invalid JsString units")) };
        let units = values.into_iter().map(|v| match v {
            Value::Number(n) if (0.0..=65535.0).contains(&n) && n.fract() == 0.0 => Ok(n as u16),
            _ => Err(error("invalid JsString unit")),
        }).collect::<Result<Vec<_>, _>>()?;
        Ok(Value::String(JsString::from_units(units)))
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(self, _: &'static str, _: u32, variant: &'static str, v: &T) -> Result<Value, Error> {
        Ok(Value::Object(vec![(variant.into(), v.serialize(self)?)]))
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Sequence, Error> { Ok(Sequence(Vec::new())) }
    fn serialize_tuple(self, len: usize) -> Result<Sequence, Error> { self.serialize_seq(Some(len)) }
    fn serialize_tuple_struct(self, _: &'static str, len: usize) -> Result<Sequence, Error> { self.serialize_seq(Some(len)) }
    fn serialize_tuple_variant(self, _: &'static str, _: u32, variant: &'static str, _: usize) -> Result<VariantSequence, Error> { Ok(VariantSequence(variant, Sequence(Vec::new()))) }
    fn serialize_map(self, _: Option<usize>) -> Result<Object, Error> { Ok(Object { entries: Vec::new(), key: None }) }
    fn serialize_struct(self, _: &'static str, len: usize) -> Result<Object, Error> { self.serialize_map(Some(len)) }
    fn serialize_struct_variant(self, _: &'static str, _: u32, variant: &'static str, _: usize) -> Result<VariantObject, Error> { Ok(VariantObject(variant, Object { entries: Vec::new(), key: None })) }
}
pub struct Sequence(Vec<Value>);
impl ser::SerializeSeq for Sequence {
    type Ok = Value; type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        self.0.push(value.serialize(DocumentSerializer)?); Ok(())
    }
    fn end(self) -> Result<Value, Error> { Ok(Value::Array(self.0)) }
}
impl ser::SerializeTuple for Sequence {
    type Ok = Value; type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> { SerializeSeq::serialize_element(self, value) }
    fn end(self) -> Result<Value, Error> { SerializeSeq::end(self) }
}
impl ser::SerializeTupleStruct for Sequence {
    type Ok = Value; type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> { SerializeSeq::serialize_element(self, value) }
    fn end(self) -> Result<Value, Error> { SerializeSeq::end(self) }
}
pub struct Object { entries: Vec<(JsString, Value)>, key: Option<JsString> }
impl ser::SerializeMap for Object {
    type Ok = Value; type Error = Error;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), Error> {
        let Value::String(key) = key.serialize(DocumentSerializer)? else { return Err(error("expected string map key")) };
        self.key = Some(key); Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        self.entries.push((self.key.take().ok_or_else(|| error("value without map key"))?, value.serialize(DocumentSerializer)?)); Ok(())
    }
    fn end(self) -> Result<Value, Error> { Ok(ordered_object(self.entries)) }
}
impl ser::SerializeStruct for Object {
    type Ok = Value; type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result<(), Error> {
        self.entries.push((key.into(), value.serialize(DocumentSerializer)?)); Ok(())
    }
    fn end(self) -> Result<Value, Error> { Ok(ordered_object(self.entries)) }
}
pub struct VariantSequence(&'static str, Sequence);
impl ser::SerializeTupleVariant for VariantSequence {
    type Ok = Value; type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> { SerializeSeq::serialize_element(&mut self.1, value) }
    fn end(self) -> Result<Value, Error> { Ok(Value::Object(vec![(self.0.into(), SerializeSeq::end(self.1)?)])) }
}
pub struct VariantObject(&'static str, Object);
impl ser::SerializeStructVariant for VariantObject {
    type Ok = Value; type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result<(), Error> { ser::SerializeStruct::serialize_field(&mut self.1, key, value) }
    fn end(self) -> Result<Value, Error> { Ok(Value::Object(vec![(self.0.into(), ser::SerializeStruct::end(self.1)?)])) }
}
