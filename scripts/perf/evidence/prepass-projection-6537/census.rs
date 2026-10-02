// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Diagnostic only for #6537: no grammar, decoder, or runtime modifications.
// Counts a superset of prepass direct record attributes; indirect style records
// and prepass branches not executed for a particular file are not timed here.
use ifc_lite_core::{AttributeValue, EntityScanner};
use ifc_lite_core::parser::{parse_entity, Token};
use std::{collections::BTreeMap, hint::black_box, time::Instant};
use serde_json::{json, Value};

#[derive(Default)]
struct Counts { records: usize, malformed: usize, bytes: usize, nodes: usize, unused_nodes: usize, unused_strings: usize, unused_string_bytes: usize, unused_lists: usize, parse_ns: u128, conversion_ns: u128 }
fn used_slots(name: &str) -> Option<&'static [usize]> {
    match name {
        "IFCSTYLEDITEM" => Some(&[0,1]),
        "IFCMATERIALDEFINITIONREPRESENTATION" => Some(&[2,3]),
        "IFCRELASSOCIATESMATERIAL" | "IFCRELVOIDSELEMENT" | "IFCRELFILLSELEMENT" | "IFCRELAGGREGATES" | "IFCRELDEFINESBYTYPE" => Some(&[4,5]),
        _ => None,
    }
}
fn count(token: &Token<'_>, unused: bool, row: &mut Counts) {
    let mut pending=vec![token];
    while let Some(value)=pending.pop() {
        row.nodes+=1;
        if unused { row.unused_nodes+=1; }
        match value {
            Token::String(bytes) | Token::Enum(bytes) if unused => {row.unused_strings+=1;row.unused_string_bytes+=bytes.len();},
            Token::List(values) | Token::TypedValue(_, values) => {if unused {row.unused_lists+=1;}pending.extend(values);},
            _ => {},
        }
    }
}
fn run(path: &str) -> Result<Value,Box<dyn std::error::Error>> {
    let source=std::fs::read(path)?;
    let begin=Instant::now();
    let mut rows:BTreeMap<String,Counts>=BTreeMap::new();
    let mut scanner=EntityScanner::new(&source);
    let mut entities=0;
    while let Some((_id,name,start,end))=scanner.next_entity() {
        entities+=1;
        let upper=name.to_ascii_uppercase();
        let Some(used)=used_slots(&upper) else {continue;};
        let row=rows.entry(upper).or_default();
        row.records+=1;row.bytes+=end-start;
        let parse_start=Instant::now();
        let parsed=parse_entity(&source[start..end]);
        row.parse_ns+=parse_start.elapsed().as_nanos();
        let Ok((_parsed_id,_kind,tokens))=parsed else {row.malformed+=1;continue;};
        // Conversion uses the exact existing funnel including IFC string escapes.
        let conversion_start=Instant::now();
        black_box(tokens.iter().map(AttributeValue::from_token).collect::<Vec<_>>());
        row.conversion_ns+=conversion_start.elapsed().as_nanos();
        for (slot,token) in tokens.iter().enumerate() {count(token,!used.contains(&slot),row);}
    }
    let rows:Vec<Value>=rows.into_iter().map(|(name,r)|json!({"type":name,"records":r.records,"malformed":r.malformed,"recordBytes":r.bytes,"tokenNodes":r.nodes,"unusedTokenNodes":r.unused_nodes,"unusedStringOrEnumValues":r.unused_strings,"unusedStringOrEnumBytes":r.unused_string_bytes,"unusedListOrTypedContainers":r.unused_lists,"directRecordParseMs":r.parse_ns as f64/1e6,"allAttributesConversionAndDropMs":r.conversion_ns as f64/1e6})).collect();
    Ok(json!({"path":path,"sourceBytes":source.len(),"scannedEntities":entities,"scanPlusObservationMs":begin.elapsed().as_secs_f64()*1000.,"rows":rows,"limits":["one diagnostic pass, not A/B or end-to-end worker-pool timing","clock pairs and census traversal perturb execution","direct spans only; indirect style/material decoding excluded","superset includes conditional branches that canonical prepass may skip","allAttributesConversionAndDropMs is an upper bound on avoidable direct conversion, not saved time; parser token trees remain necessary","no grammar, runtime source, cache, output or error behavior changed"]}))
}
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let values:Vec<Value>=std::env::args().skip(1).map(|p|run(&p)).collect::<Result<_,_>>()?;
    println!("{}",serde_json::to_string_pretty(&values)?);Ok(())
}
