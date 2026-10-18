// SPDX-License-Identifier: MPL-2.0
// Bounded sampling of successful Rust allocation requests, not native heap profiling.
mod fingerprint;
use std::alloc::{GlobalAlloc,Layout,System};
use std::cell::{Cell,UnsafeCell};
use std::mem::MaybeUninit;
use std::sync::atomic::{AtomicBool,AtomicU64,AtomicUsize,Ordering};
use serde::Serialize;
const INTERVAL:u64=2048;
const CAPACITY:usize=32768;
const DEPTH:usize=96;
static ENABLED:AtomicBool=AtomicBool::new(false);
static ACTIVE:AtomicUsize=AtomicUsize::new(0);
static EVENTS:AtomicU64=AtomicU64::new(0);
static REQUESTED:AtomicU64=AtomicU64::new(0);
static ALLOCS:AtomicU64=AtomicU64::new(0);
static REALLOCS:AtomicU64=AtomicU64::new(0);
static INDEX:AtomicUsize=AtomicUsize::new(0);
static DROPPED:AtomicUsize=AtomicUsize::new(0);
static REENTRANT:AtomicUsize=AtomicUsize::new(0);
static ITERATION:AtomicUsize=AtomicUsize::new(0);
thread_local!{static RECURSION:Cell<bool>=const{Cell::new(false)};}
#[derive(Clone,Copy)] struct Trace{iteration:usize,event:u64,kind:u8,old_size:usize,size:usize,n:usize,frames:[usize;DEPTH]}
struct Slot(UnsafeCell<MaybeUninit<Trace>>);
// Every writer owns a unique atomic slot; readers run after disable + ACTIVE drain.
unsafe impl Sync for Slot{}
static SLOTS:[Slot;CAPACITY]=[const{Slot(UnsafeCell::new(MaybeUninit::uninit()))};CAPACITY];
extern "C"{fn backtrace(buffer:*mut *mut std::ffi::c_void,size:std::ffi::c_int)->std::ffi::c_int;}
struct Active;
impl Drop for Active{fn drop(&mut self){ACTIVE.fetch_sub(1,Ordering::SeqCst);}}
#[inline(never)]
fn allocation_sample(kind:u8,old_size:usize,size:usize){
    if !ENABLED.load(Ordering::SeqCst){return}
    ACTIVE.fetch_add(1,Ordering::SeqCst);let _active=Active;
    if !ENABLED.load(Ordering::SeqCst){return}
    if RECURSION.with(|r|r.get()){REENTRANT.fetch_add(1,Ordering::Relaxed);return}
    let event=EVENTS.fetch_add(1,Ordering::Relaxed);
    REQUESTED.fetch_add(size as u64,Ordering::Relaxed);
    if kind==2{REALLOCS.fetch_add(1,Ordering::Relaxed);}else{ALLOCS.fetch_add(1,Ordering::Relaxed);}
    if event%INTERVAL!=0{return}
    let index=INDEX.fetch_add(1,Ordering::Relaxed);
    if index>=CAPACITY{DROPPED.fetch_add(1,Ordering::Relaxed);return}
    RECURSION.with(|r|r.set(true));
    let mut trace=Trace{iteration:ITERATION.load(Ordering::Relaxed),event,kind,old_size,size,n:0,frames:[0;DEPTH]};
    trace.n=unsafe{backtrace(trace.frames.as_mut_ptr().cast(),DEPTH as i32)}.max(0) as usize;
    unsafe{(*SLOTS[index].0.get()).write(trace);}
    RECURSION.with(|r|r.set(false));
}
struct Tracked;
unsafe impl GlobalAlloc for Tracked{
    unsafe fn alloc(&self,l:Layout)->*mut u8{let p=System.alloc(l);if !p.is_null(){allocation_sample(0,0,l.size());}p}
    unsafe fn alloc_zeroed(&self,l:Layout)->*mut u8{let p=System.alloc_zeroed(l);if !p.is_null(){allocation_sample(1,0,l.size());}p}
    unsafe fn realloc(&self,p:*mut u8,l:Layout,n:usize)->*mut u8{let p=System.realloc(p,l,n);if !p.is_null(){allocation_sample(2,l.size(),n);}p}
    unsafe fn dealloc(&self,p:*mut u8,l:Layout){System.dealloc(p,l)}
}
#[global_allocator]static GLOBAL:Tracked=Tracked;
#[inline(never)]
fn sampler_probe(){let mut v=Vec::<u8>::with_capacity(65537);v.resize(65537,7);std::hint::black_box(&v);}
fn warm(){let mut frames=[0usize;DEPTH];assert!(unsafe{backtrace(frames.as_mut_ptr().cast(),DEPTH as i32)}>0);}
#[derive(Serialize)]struct ExportTrace{iteration:usize,event:u64,kind:u8,old_size:usize,size:usize,truncated:bool,frames:Vec<usize>}
#[derive(Serialize)]struct Iteration{iteration:usize,successful_events:u64,allocation_calls:u64,reallocation_calls:u64,requested_bytes:u64,samples:usize,meshes:usize,vertices:usize,triangles:usize,fingerprint:String}
fn main(){
    let args:Vec<String>=std::env::args().collect();let content=std::fs::read(&args[1]).unwrap();
    let iters:usize=args.get(2).map_or(2,|v|v.parse().unwrap());
    warm();rayon::ThreadPoolBuilder::new().build_global().unwrap();drop(rayon::broadcast(|_|warm()));
    ENABLED.store(true,Ordering::SeqCst);sampler_probe();ENABLED.store(false,Ordering::SeqCst);
    while ACTIVE.load(Ordering::SeqCst)!=0{std::hint::spin_loop()}
    assert_eq!(INDEX.load(Ordering::Relaxed),1);
    let probe=unsafe{(*SLOTS[0].0.get()).assume_init_ref()};assert_eq!(probe.size,65537);assert!(probe.n>0);
    let probe_frames=probe.frames[..probe.n].to_vec();
    EVENTS.store(0,Ordering::Relaxed);REQUESTED.store(0,Ordering::Relaxed);ALLOCS.store(0,Ordering::Relaxed);REALLOCS.store(0,Ordering::Relaxed);INDEX.store(0,Ordering::Relaxed);
    let mut iterations=Vec::with_capacity(iters);
    for iteration in 0..iters{
        ITERATION.store(iteration,Ordering::Relaxed);let (e,a,r,b,s)=(EVENTS.load(Ordering::Relaxed),ALLOCS.load(Ordering::Relaxed),REALLOCS.load(Ordering::Relaxed),REQUESTED.load(Ordering::Relaxed),INDEX.load(Ordering::Relaxed));
        ENABLED.store(true,Ordering::SeqCst);
        let result=ifc_lite_processing::process_geometry(&content);
        ENABLED.store(false,Ordering::SeqCst);while ACTIVE.load(Ordering::SeqCst)!=0{std::hint::spin_loop()}
        let counters=(EVENTS.load(Ordering::Relaxed)-e,ALLOCS.load(Ordering::Relaxed)-a,REALLOCS.load(Ordering::Relaxed)-r,REQUESTED.load(Ordering::Relaxed)-b,INDEX.load(Ordering::Relaxed)-s);
        let fingerprint=fingerprint::mesh_fingerprint(&result.meshes);
        iterations.push(Iteration{iteration,successful_events:counters.0,allocation_calls:counters.1,reallocation_calls:counters.2,requested_bytes:counters.3,samples:counters.4,meshes:result.meshes.len(),vertices:result.meshes.iter().map(|m|m.positions.len()/3).sum(),triangles:result.meshes.iter().map(|m|m.indices.len()/3).sum(),fingerprint});
        drop(result);
    }
    let traces:Vec<_>=(0..INDEX.load(Ordering::Relaxed).min(CAPACITY)).map(|i|{
        let t=unsafe{(*SLOTS[i].0.get()).assume_init_ref()};ExportTrace{iteration:t.iteration,event:t.event,kind:t.kind,old_size:t.old_size,size:t.size,truncated:t.n==DEPTH,frames:t.frames[..t.n].to_vec()}
    }).collect();
    println!("{}",serde_json::to_string(&serde_json::json!({"probe_frames":probe_frames,"sampler_probe_verified":true,"threads":rayon::current_num_threads(),"file_bytes":content.len(),"interval":INTERVAL,"capacity":CAPACITY,"depth":DEPTH,"dropped":DROPPED.load(Ordering::Relaxed),"reentrant_excluded":REENTRANT.load(Ordering::Relaxed),"iterations":iterations,"traces":traces})).unwrap());
}
