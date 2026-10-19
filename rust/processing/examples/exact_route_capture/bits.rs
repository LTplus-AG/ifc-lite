// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Serialize before JSON can round floats, erase negative zero, or null NaNs.
use serde::{ser, Serialize};
use serde_json::{Map, Value};
type Error = serde_json::Error;
type Result<T> = std::result::Result<T, Error>;

pub fn value<T: Serialize + ?Sized>(v: &T) -> Result<Value> { v.serialize(Bits) }
pub struct Bits;
pub struct Compound { value: Value, key: Option<String>, variant: Option<String> }
impl Compound {
    fn array(variant: Option<String>) -> Self {
        Self { value: Value::Array(Vec::new()), key: None, variant }
    }
    fn object(variant: Option<String>) -> Self {
        Self { value: Value::Object(Map::new()), key: None, variant }
    }
    fn push<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<()> {
        self.value.as_array_mut().unwrap().push(value(v)?); Ok(())
    }
    fn field<T: Serialize + ?Sized>(&mut self, key: &str, v: &T) -> Result<()> {
        let object = self.value.as_object_mut().unwrap();
        if object.insert(key.to_owned(), value(v)?).is_some() {
            return Err(ser::Error::custom("duplicate serialized map key"));
        }
        Ok(())
    }
    fn finish(self) -> Result<Value> {
        if self.key.is_some() { return Err(ser::Error::custom("unpaired map key")); }
        Ok(match self.variant {
            Some(name) => Value::Object([(name, self.value)].into_iter().collect()),
            None => self.value,
        })
    }
}
macro_rules! integer {
    ($($method:ident:$ty:ty),*) => {$ (
        fn $method(self, v: $ty) -> Result<Value> {
            // Strings preserve every integer bit through JS and u128 JSON readers.
            Ok(Value::String(format!("{}:{v}", stringify!($ty))))
        }
    )*};
}
impl ser::Serializer for Bits {
    type Ok = Value;
    type Error = Error;
    type SerializeSeq = Compound;
    type SerializeTuple = Compound;
    type SerializeTupleStruct = Compound;
    type SerializeTupleVariant = Compound;
    type SerializeMap = Compound;
    type SerializeStruct = Compound;
    type SerializeStructVariant = Compound;
    integer!(serialize_i8:i8, serialize_i16:i16, serialize_i32:i32, serialize_i64:i64,
        serialize_i128:i128, serialize_u8:u8, serialize_u16:u16, serialize_u32:u32,
        serialize_u64:u64, serialize_u128:u128);
    fn serialize_f32(self, v: f32) -> Result<Value> {
        if !v.is_finite() { return Err(ser::Error::custom("nonfinite f32 output")); }
        Ok(Value::String(format!("f32:{:08x}", v.to_bits())))
    }
    fn serialize_f64(self, v: f64) -> Result<Value> {
        if !v.is_finite() { return Err(ser::Error::custom("nonfinite f64 output")); }
        Ok(Value::String(format!("f64:{:016x}", v.to_bits())))
    }
    fn serialize_bool(self, v: bool) -> Result<Value> { Ok(Value::Bool(v)) }
    fn serialize_str(self, v: &str) -> Result<Value> { Ok(Value::String(v.into())) }
    fn serialize_char(self, v: char) -> Result<Value> { self.serialize_str(&v.to_string()) }
    fn serialize_bytes(self, v: &[u8]) -> Result<Value> { value(v) }
    fn serialize_none(self) -> Result<Value> { Ok(Value::Null) }
    fn serialize_some<T: Serialize + ?Sized>(self, v: &T) -> Result<Value> { value(v) }
    fn serialize_unit(self) -> Result<Value> { Ok(Value::Null) }
    fn serialize_unit_struct(self, _: &'static str) -> Result<Value> { self.serialize_unit() }
    fn serialize_unit_variant(self, _: &'static str, _: u32, name: &'static str) -> Result<Value> {
        self.serialize_str(name)
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, _: &'static str, v: &T) -> Result<Value> {
        value(v)
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(self, _: &'static str, _: u32,
        name: &'static str, v: &T) -> Result<Value> {
        Ok(Value::Object([(name.into(), value(v)?)].into_iter().collect()))
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Compound> { Ok(Compound::array(None)) }
    fn serialize_tuple(self, _: usize) -> Result<Compound> { self.serialize_seq(None) }
    fn serialize_tuple_struct(self, _: &'static str, _: usize) -> Result<Compound> { self.serialize_seq(None) }
    fn serialize_tuple_variant(self, _: &'static str, _: u32, name: &'static str, _: usize) -> Result<Compound> {
        Ok(Compound::array(Some(name.into())))
    }
    fn serialize_map(self, _: Option<usize>) -> Result<Compound> { Ok(Compound::object(None)) }
    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Compound> { self.serialize_map(None) }
    fn serialize_struct_variant(self, _: &'static str, _: u32, name: &'static str, _: usize) -> Result<Compound> {
        Ok(Compound::object(Some(name.into())))
    }
}
macro_rules! sequence {
    ($trait:ident, $method:ident) => {
        impl ser::$trait for Compound {
            type Ok = Value; type Error = Error;
            fn $method<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<()> { self.push(v) }
            fn end(self) -> Result<Value> { self.finish() }
        }
    };
}
sequence!(SerializeSeq, serialize_element);
sequence!(SerializeTuple, serialize_element);
sequence!(SerializeTupleStruct, serialize_field);
sequence!(SerializeTupleVariant, serialize_field);
impl ser::SerializeMap for Compound {
    type Ok = Value; type Error = Error;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<()> {
        if self.key.is_some() { return Err(ser::Error::custom("unpaired map key")); }
        self.key = Some(match value(key)? {
            Value::String(s) => s,
            other => return Err(ser::Error::custom(format!("unsupported map key {other}"))),
        }); Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<()> {
        let key = self.key.take().ok_or_else(|| <Error as ser::Error>::custom("missing map key"))?;
        self.field(&key, v)
    }
    fn end(self) -> Result<Value> { self.finish() }
}
macro_rules! structure {
    ($trait:ident) => {
        impl ser::$trait for Compound {
            type Ok = Value; type Error = Error;
            fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, v: &T) -> Result<()> {
                self.field(key, v)
            }
            fn end(self) -> Result<Value> { self.finish() }
        }
    };
}
structure!(SerializeStruct);
structure!(SerializeStructVariant);

#[cfg(test)]
mod tests {
    use super::value;
    #[test]
    fn preservation_gate_keeps_bits_and_rejects_nonfinite() {
        assert_ne!(value(&0.0f32).unwrap(), value(&-0.0f32).unwrap());
        assert_ne!(value(&1.0f64).unwrap(), value(&f64::from_bits(1.0f64.to_bits()+1)).unwrap());
        for v in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] { assert!(value(&v).is_err()); }
        assert!(value(&vec![f32::NAN]).is_err());
        assert_eq!(value(&u128::MAX).unwrap(), format!("u128:{}", u128::MAX));
    }
}
