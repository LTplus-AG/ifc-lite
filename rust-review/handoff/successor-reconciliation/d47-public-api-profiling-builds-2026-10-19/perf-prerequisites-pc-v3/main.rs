// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// External D47 public API wrapper. No production instrumentation or policy math.
use std::{path::Path, time::Instant};
use ifc_lite_export::{build_export_model, stream_export_model, export_csv, CsvMode, CsvOptions, EntityRow};
use ifc_lite_processing::data_model::extract_data_model;
use serde_json::{json, Value};
fn proc_kib(label: &str) -> usize {
    let status = std::fs::read_to_string("/proc/self/status").expect("Linux /proc/self/status");
    status.lines().find_map(|line| line.strip_prefix(label)
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse().ok())).expect("memory field in proc status")
}
fn rows_json(rows: &[EntityRow]) -> Value {
    json!(rows.iter().map(|row| json!({"express_id":row.express_id,"full_row_debug":format!("{row:?}"),
        "property_sets":row.property_sets.iter().map(|set| json!({"name":set.name,"properties":set.properties.iter().map(|p|
            json!({"name":p.name,"value":p.value,"value_type":p.value_type,"kind":format!("{:?}",p.kind)})).collect::<Vec<_>>()})).collect::<Vec<_>>()
    })).collect::<Vec<_>>())
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len()==2 && args[1]=="--identity" { println!("{}",json!({"source":env!("D47_SOURCE_HEAD"),"clock":"std::time::Instant","rss":"/proc/self/status VmRSS/VmHWM","profile":"profiling"})); return; }
    assert!(args.len()==5,"mode(measure|witness) API(stream|build|csv|server) INPUT OUTPUT");
    let witness=args[1]=="witness";assert!(witness || args[1]=="measure");
    let content=std::fs::read(&args[3]).expect("input");
    let baseline=json!({"rss_kib":proc_kib("VmRSS:"),"hwm_kib":proc_kib("VmHWM:")});
    let mut first=None;let mut last=None;let mut count=0;let mut rows=Vec::new();
    let started=Instant::now();
    let (units,model,csv,server)=match args[2].as_str() {
        "stream"=>{let units=stream_export_model(&content,|row| {
            if !witness { let elapsed=started.elapsed().as_nanos();if first.is_none(){first=Some(elapsed)}last=Some(elapsed); }
            count+=1;if witness {rows.push(row)}
        });(Some(units),None,None,None)},
        "build"=>(None,Some(build_export_model(&content)),None,None),
        "csv"=>(None,None,Some(export_csv(&content,CsvMode::Properties,&CsvOptions::default())),None),
        "server"=>(None,None,None,Some(extract_data_model(&content))),
        _=>panic!("unknown public API"),
    };
    let elapsed=started.elapsed().as_nanos();
    let live_peak=proc_kib("VmHWM:");let live_rss=proc_kib("VmRSS:");
    // Retained results remain live through RSS observation. Witness serialization is outside all windows.
    let model_rows=model.as_ref().map(|m|m.entities.len());
    let server_rows=server.as_ref().map(|m|m.entities.len());
    let output_bytes=csv.as_ref().map(|s|s.len());
    if witness {
        let value=if let Some(ref m)=model {json!({"rows":rows_json(&m.entities),"units_debug":format!("{:?}",m.units)})}
        else if let Some(ref m)=server {json!({"entities":m.entities,"property_sets":m.property_sets,"quantity_sets":m.quantity_sets,"refused":m.refused})}
        else if let Some(ref s)=csv {json!({"csv":s})}
        else {json!({"rows":rows_json(&rows),"units_debug":format!("{:?}",units.unwrap())})};
        std::fs::write(Path::new(&args[4]),serde_json::to_vec(&value).unwrap()).unwrap();
    } else {
        std::fs::write(Path::new(&args[4]),serde_json::to_vec(&json!({"source":env!("D47_SOURCE_HEAD"),"api":args[2],"input_bytes":content.len(),"entry_to_return_ns":elapsed,"entry_to_first_callback_ns":first,"entry_to_last_callback_ns":last,"stream_rows":count,"model_rows":model_rows,"server_rows":server_rows,"serialized_bytes":output_bytes,"baseline":baseline,"live_peak_rss_kib":live_peak,"live_rss_kib":live_rss,"result_drop":"after RSS and summary/witness serialization"})).unwrap()).unwrap();
    }
    std::hint::black_box((&model,&csv,&server));
}
