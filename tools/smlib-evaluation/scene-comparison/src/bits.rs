// SPDX-License-Identifier: MPL-2.0
//! A serializer adapter retaining IEEE floats and wide identities. Map ordering
//! is supplied by serde_json::Value's default ordered map implementation.
use serde::ser::*;
use serde::Serialize;

pub struct Exact<'a,T:?Sized>(pub &'a T);
impl<T:Serialize+?Sized> Serialize for Exact<'_,T> {
    fn serialize<S:Serializer>(&self,s:S)->Result<S::Ok,S::Error> {self.0.serialize(Bits(s))}
}
struct Bits<S>(S);
struct Compound<C>(C);
macro_rules! scalar {
    ($($name:ident($ty:ty)),* $(,)?)=>{$(fn $name(self,v:$ty)->Result<Self::Ok,Self::Error>{self.0.$name(v)})*};
}
impl<S:Serializer> Serializer for Bits<S> {
    type Ok=S::Ok; type Error=S::Error;
    type SerializeSeq=Compound<S::SerializeSeq>;
    type SerializeTuple=Compound<S::SerializeTuple>;
    type SerializeTupleStruct=Compound<S::SerializeTupleStruct>;
    type SerializeTupleVariant=Compound<S::SerializeTupleVariant>;
    type SerializeMap=Compound<S::SerializeMap>;
    type SerializeStruct=Compound<S::SerializeStruct>;
    type SerializeStructVariant=Compound<S::SerializeStructVariant>;
    scalar!(serialize_bool(bool),serialize_i8(i8),serialize_i16(i16),serialize_i32(i32),serialize_i64(i64),
        serialize_u8(u8),serialize_u16(u16),serialize_u32(u32),serialize_u64(u64),serialize_bytes(&[u8]));
    fn serialize_str(self,v:&str)->Result<Self::Ok,Self::Error>{self.0.serialize_str(&format!("str:{v}"))}
    fn serialize_char(self,v:char)->Result<Self::Ok,Self::Error>{self.0.serialize_str(&format!("char:{v}"))}
    fn serialize_i128(self,v:i128)->Result<Self::Ok,Self::Error>{self.0.serialize_str(&format!("i128:{v}"))}
    fn serialize_u128(self,v:u128)->Result<Self::Ok,Self::Error>{self.0.serialize_str(&format!("u128:{v}"))}
    fn serialize_f32(self,v:f32)->Result<Self::Ok,Self::Error>{self.0.serialize_str(&format!("f32:{:08x}",v.to_bits()))}
    fn serialize_f64(self,v:f64)->Result<Self::Ok,Self::Error>{self.0.serialize_str(&format!("f64:{:016x}",v.to_bits()))}
    fn serialize_none(self)->Result<Self::Ok,Self::Error>{self.0.serialize_str("none")}
    fn serialize_some<T:Serialize+?Sized>(self,v:&T)->Result<Self::Ok,Self::Error>{
        let mut tuple=self.0.serialize_tuple(2)?;
        tuple.serialize_element("some")?;
        tuple.serialize_element(&Exact(v))?;
        tuple.end()
    }
    fn serialize_unit(self)->Result<Self::Ok,Self::Error>{self.0.serialize_str("unit")}
    fn serialize_unit_struct(self,n:&'static str)->Result<Self::Ok,Self::Error>{self.0.serialize_str(&format!("unitstruct:{n}"))}
    fn serialize_unit_variant(self,n:&'static str,i:u32,v:&'static str)->Result<Self::Ok,Self::Error>{self.0.serialize_unit_variant(n,i,v)}
    fn serialize_newtype_struct<T:Serialize+?Sized>(self,n:&'static str,v:&T)->Result<Self::Ok,Self::Error>{self.0.serialize_newtype_struct(n,&Exact(v))}
    fn serialize_newtype_variant<T:Serialize+?Sized>(self,n:&'static str,i:u32,v:&'static str,x:&T)->Result<Self::Ok,Self::Error>{self.0.serialize_newtype_variant(n,i,v,&Exact(x))}
    fn serialize_seq(self,n:Option<usize>)->Result<Self::SerializeSeq,Self::Error>{self.0.serialize_seq(n).map(Compound)}
    fn serialize_tuple(self,n:usize)->Result<Self::SerializeTuple,Self::Error>{self.0.serialize_tuple(n).map(Compound)}
    fn serialize_tuple_struct(self,n:&'static str,l:usize)->Result<Self::SerializeTupleStruct,Self::Error>{self.0.serialize_tuple_struct(n,l).map(Compound)}
    fn serialize_tuple_variant(self,n:&'static str,i:u32,v:&'static str,l:usize)->Result<Self::SerializeTupleVariant,Self::Error>{self.0.serialize_tuple_variant(n,i,v,l).map(Compound)}
    fn serialize_map(self,n:Option<usize>)->Result<Self::SerializeMap,Self::Error>{self.0.serialize_map(n).map(Compound)}
    fn serialize_struct(self,n:&'static str,l:usize)->Result<Self::SerializeStruct,Self::Error>{self.0.serialize_struct(n,l).map(Compound)}
    fn serialize_struct_variant(self,n:&'static str,i:u32,v:&'static str,l:usize)->Result<Self::SerializeStructVariant,Self::Error>{self.0.serialize_struct_variant(n,i,v,l).map(Compound)}
}
macro_rules! sequence {
    ($trait:ident,$method:ident)=>{
        impl<C:$trait> $trait for Compound<C> {
            type Ok=C::Ok;type Error=C::Error;
            fn $method<T:Serialize+?Sized>(&mut self,v:&T)->Result<(),Self::Error>{self.0.$method(&Exact(v))}
            fn end(self)->Result<Self::Ok,Self::Error>{self.0.end()}
        }
    };
}
sequence!(SerializeSeq,serialize_element);
sequence!(SerializeTuple,serialize_element);
sequence!(SerializeTupleStruct,serialize_field);
sequence!(SerializeTupleVariant,serialize_field);
impl<C:SerializeMap> SerializeMap for Compound<C> {
    type Ok=C::Ok;type Error=C::Error;
    fn serialize_key<T:Serialize+?Sized>(&mut self,v:&T)->Result<(),Self::Error>{self.0.serialize_key(&Exact(v))}
    fn serialize_value<T:Serialize+?Sized>(&mut self,v:&T)->Result<(),Self::Error>{self.0.serialize_value(&Exact(v))}
    fn end(self)->Result<Self::Ok,Self::Error>{self.0.end()}
}
macro_rules! structure {
    ($trait:ident)=>{
        impl<C:$trait> $trait for Compound<C> {
            type Ok=C::Ok;type Error=C::Error;
            fn serialize_field<T:Serialize+?Sized>(&mut self,k:&'static str,v:&T)->Result<(),Self::Error>{self.0.serialize_field(k,&Exact(v))}
            fn end(self)->Result<Self::Ok,Self::Error>{self.0.end()}
        }
    };
}
structure!(SerializeStruct);
structure!(SerializeStructVariant);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ieee_payloads_and_signed_zero_survive_nested_serialization() {
        let values=vec![0f32,-0.,f32::from_bits(0x7fc00001),f32::from_bits(0x7fc00002),f32::INFINITY];
        let encoded=serde_json::to_value(Exact(&values)).unwrap();
        assert_eq!(encoded,serde_json::json!(["f32:00000000","f32:80000000","f32:7fc00001","f32:7fc00002","f32:7f800000"]));
    }
    #[test]
    fn source_strings_cannot_impersonate_float_identity_or_option_tags() {
        for (source,other) in [
            (serde_json::json!("f64:3ff0000000000000"),serde_json::json!(1.0)),
            (serde_json::json!("unit"),serde_json::Value::Null),
        ] {
            assert_ne!(serde_json::to_value(Exact(&source)).unwrap(),serde_json::to_value(Exact(&other)).unwrap());
        }
        assert_ne!(serde_json::to_value(Exact(&None::<serde_json::Value>)).unwrap(),
            serde_json::to_value(Exact(&Some(serde_json::Value::Null))).unwrap());
        assert_ne!(serde_json::to_value(Exact(&"u128:1")).unwrap(),serde_json::to_value(Exact(&1u128)).unwrap());
    }
    #[test]
    fn maps_are_ordered_but_sequences_and_wide_identity_are_not_normalized() {
        let map:std::collections::HashMap<_,_>=[("z",vec![2f64,1.]),("a",vec![0.])].into();
        let encoded=serde_json::to_value(Exact(&map)).unwrap();
        assert_eq!(serde_json::to_string(&encoded).unwrap(),"{\"str:a\":[\"f64:0000000000000000\"],\"str:z\":[\"f64:4000000000000000\",\"f64:3ff0000000000000\"]}");
        assert_eq!(serde_json::to_value(Exact(&u128::MAX)).unwrap(),format!("u128:{}",u128::MAX));
    }
}
