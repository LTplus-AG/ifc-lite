// SPDX-License-Identifier: MPL-2.0
// Whole-process requested-allocation diagnostic, not a limiting allocator.
mod fingerprint;
use std::alloc::{GlobalAlloc,Layout,System};
use std::sync::atomic::{AtomicU64,Ordering::Relaxed};
use serde::Serialize;
static LIVE:AtomicU64=AtomicU64::new(0);
static PEAK:AtomicU64=AtomicU64::new(0);
static ALLOCS:AtomicU64=AtomicU64::new(0);
static ZEROED:AtomicU64=AtomicU64::new(0);
static ALLOC_BYTES:AtomicU64=AtomicU64::new(0);
static FREES:AtomicU64=AtomicU64::new(0);
static FREE_BYTES:AtomicU64=AtomicU64::new(0);
static REALLOCS:AtomicU64=AtomicU64::new(0);
static REALLOC_OLD:AtomicU64=AtomicU64::new(0);
static REALLOC_NEW:AtomicU64=AtomicU64::new(0);
static FAILED:AtomicU64=AtomicU64::new(0);
struct Tracked;
fn grow(bytes:u64){let now=LIVE.fetch_add(bytes,Relaxed)+bytes;PEAK.fetch_max(now,Relaxed);}
unsafe impl GlobalAlloc for Tracked {
    unsafe fn alloc(&self,l:Layout)->*mut u8 {
        let p=System.alloc(l);if p.is_null(){FAILED.fetch_add(1,Relaxed);}else{
            ALLOCS.fetch_add(1,Relaxed);ALLOC_BYTES.fetch_add(l.size() as u64,Relaxed);grow(l.size() as u64);
        }p
    }
    unsafe fn alloc_zeroed(&self,l:Layout)->*mut u8 {
        let p=System.alloc_zeroed(l);if p.is_null(){FAILED.fetch_add(1,Relaxed);}else{
            ZEROED.fetch_add(1,Relaxed);ALLOC_BYTES.fetch_add(l.size() as u64,Relaxed);grow(l.size() as u64);
        }p
    }
    unsafe fn dealloc(&self,p:*mut u8,l:Layout){
        System.dealloc(p,l);FREES.fetch_add(1,Relaxed);FREE_BYTES.fetch_add(l.size() as u64,Relaxed);LIVE.fetch_sub(l.size() as u64,Relaxed);
    }
    unsafe fn realloc(&self,p:*mut u8,l:Layout,n:usize)->*mut u8 {
        let q=System.realloc(p,l,n);if q.is_null(){FAILED.fetch_add(1,Relaxed);}else{
            REALLOCS.fetch_add(1,Relaxed);REALLOC_OLD.fetch_add(l.size() as u64,Relaxed);REALLOC_NEW.fetch_add(n as u64,Relaxed);
            if n>=l.size(){grow((n-l.size()) as u64)}else{LIVE.fetch_sub((l.size()-n) as u64,Relaxed);}
        }q
    }
}
#[global_allocator] static GLOBAL:Tracked=Tracked;
#[derive(Clone,Copy,Serialize)]
struct Snapshot{live:u64,peak:u64,alloc_calls:u64,zeroed_calls:u64,alloc_bytes:u64,free_calls:u64,free_bytes:u64,realloc_calls:u64,realloc_old_bytes:u64,realloc_new_bytes:u64,failed:u64}
fn snap()->Snapshot{Snapshot{live:LIVE.load(Relaxed),peak:PEAK.load(Relaxed),alloc_calls:ALLOCS.load(Relaxed),zeroed_calls:ZEROED.load(Relaxed),alloc_bytes:ALLOC_BYTES.load(Relaxed),free_calls:FREES.load(Relaxed),free_bytes:FREE_BYTES.load(Relaxed),realloc_calls:REALLOCS.load(Relaxed),realloc_old_bytes:REALLOC_OLD.load(Relaxed),realloc_new_bytes:REALLOC_NEW.load(Relaxed),failed:FAILED.load(Relaxed)}}
fn delta(a:Snapshot,b:Snapshot)->Snapshot{Snapshot{live:b.live,peak:b.peak,alloc_calls:b.alloc_calls-a.alloc_calls,zeroed_calls:b.zeroed_calls-a.zeroed_calls,alloc_bytes:b.alloc_bytes-a.alloc_bytes,free_calls:b.free_calls-a.free_calls,free_bytes:b.free_bytes-a.free_bytes,realloc_calls:b.realloc_calls-a.realloc_calls,realloc_old_bytes:b.realloc_old_bytes-a.realloc_old_bytes,realloc_new_bytes:b.realloc_new_bytes-a.realloc_new_bytes,failed:b.failed-a.failed}}
fn self_check(){let before=snap();let mut v=Vec::<u8>::with_capacity(1024);v.resize(1024,0);v.reserve_exact(2048);std::hint::black_box(&v);let held=snap();assert!(held.alloc_calls>before.alloc_calls&&held.realloc_calls>before.realloc_calls&&held.live>=before.live+3072);drop(v);assert_eq!(snap().live,before.live);}
#[derive(Serialize)] struct Record{iteration:usize,before:Snapshot,after_process:Snapshot,process_delta:Snapshot,after_result_drop:Snapshot,mesh_count:usize,vertices:usize,triangles:usize,fingerprint:u64}
fn main(){
    self_check();
    let args:Vec<String>=std::env::args().collect();let content=std::fs::read(&args[1]).unwrap();let iters:usize=args.get(2).map_or(5,|n|n.parse().unwrap());
    rayon::ThreadPoolBuilder::new().build_global().unwrap();drop(rayon::broadcast(|_|()));
    let threads=rayon::current_num_threads();let mut records=Vec::with_capacity(iters);
    for iteration in 0..iters{
        // NEVER reset LIVE or cumulative totals: old/file/pool allocations survive.
        PEAK.store(LIVE.load(Relaxed),Relaxed);let before=snap();
        let result=ifc_lite_processing::process_geometry(&content);
        let after_process=snap(); // fingerprint and serialization excluded from call counters.
        let mesh_count=result.meshes.len();let vertices=result.meshes.iter().map(|m|m.positions.len()/3).sum();let triangles=result.meshes.iter().map(|m|m.indices.len()/3).sum();
        let fingerprint=u64::from_str_radix(&fingerprint::mesh_fingerprint(&result.meshes),16).unwrap();
        drop(result);let after_result_drop=snap();
        records.push(Record{iteration,before,after_process,process_delta:delta(before,after_process),after_result_drop,mesh_count,vertices,triangles,fingerprint});
    }
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"threads":threads,"file_bytes":content.len(),"allocator_self_check":true,"records":records})).unwrap());
}
