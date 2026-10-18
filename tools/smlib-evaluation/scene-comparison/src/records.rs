// SPDX-License-Identifier: MPL-2.0
use crate::bits::Exact;
use serde::Serialize;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{fs::File,io::{BufWriter,Write},path::Path};

pub fn digest(bytes:&[u8])->String {format!("{:x}",Sha256::digest(bytes))}
pub struct Records {
    file:BufWriter<File>, pub manifest:Vec<Value>,
}
impl Records {
    pub fn new(folder:&Path)->Self {
        std::fs::create_dir_all(folder).expect("create receipt directory");
        Self {file:BufWriter::new(File::create(folder.join("records.jsonl")).expect("create records")),manifest:Vec::new()}
    }
    pub fn emit<T:Serialize+?Sized>(&mut self,channel:&str,key:impl ToString,value:&T) {
        let value=serde_json::to_value(Exact(value)).expect("serialize exact value");
        let key=key.to_string();
        let record=json!({"channel":channel,"key":key,"value":value});
        let bytes=serde_json::to_vec(&record).expect("encode record");
        self.manifest.push(json!({"channel":channel,"key":key,"sha256":digest(&bytes),"bytes":bytes.len()}));
        self.file.write_all(&bytes).expect("write record");
        self.file.write_all(b"\n").expect("write record boundary");
    }
    pub fn finish(mut self,folder:&Path,mut metadata:Value) {
        self.file.flush().expect("flush records");
        let semantic:Vec<_>=self.manifest.iter().filter(|r|r["channel"]!="execution").collect();
        metadata["scene_sha256"]=json!(digest(&serde_json::to_vec(&semantic).unwrap()));
        metadata["records"]=json!(self.manifest);
        std::fs::write(folder.join("manifest.json"),serde_json::to_vec_pretty(&metadata).unwrap()).expect("write complete manifest");
    }
}
