// SPDX-License-Identifier: MPL-2.0
//! Source-identical public symbolic probe for parent/integration comparisons.
//! Usage: symbolic_probe model.ifc [iterations] [none|account|source|both].
//! Authority setup, serialization and full-output hashing are outside timing.
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::resource::{
    with_source_stop, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits,
};
use ifc_lite_processing::{extract_symbolic_data, SymbolicData};
use std::time::Instant;

type ProbeResult<T> = Result<T, Box<dyn std::error::Error>>;

// The parent API is infallible; the corrected API reports ProgramStop. Both
// arms compile this identical adapter, including normalizing inside timing.
trait SymbolicOutcome {
    fn into_outcome(self) -> Result<SymbolicData, ProgramStop>;
}
impl SymbolicOutcome for SymbolicData {
    fn into_outcome(self) -> Result<SymbolicData, ProgramStop> { Ok(self) }
}
impl SymbolicOutcome for Result<SymbolicData, ProgramStop> {
    fn into_outcome(self) -> Result<SymbolicData, ProgramStop> { self }
}

#[derive(Clone, Copy)]
enum Authority { None, Account, Source, Both }
impl Authority {
    fn parse(value: &str) -> ProbeResult<Self> {
        match value {
            "none" => Ok(Self::None),
            "account" => Ok(Self::Account),
            "source" => Ok(Self::Source),
            "both" => Ok(Self::Both),
            _ => Err("authority must be none, account, source or both".into()),
        }
    }
}

fn with_authority<T>(
    mode: Authority,
    source: &[u8],
    operation: impl FnOnce() -> ProbeResult<T>,
) -> ProbeResult<T> {
    if matches!(mode, Authority::None) { return operation(); }
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    if matches!(mode, Authority::Account) { return account.scope(operation); }
    // A live validated lexical source handle, over the same input bytes.
    // This measures ambient terminal polling, not source-borrow/cache transport.
    let decoder = EntityDecoder::new(source);
    let mut lease = decoder.try_execution_lease()?;
    let work = lease.begin_synchronous_work(decoder.execution_identity())?;
    let scope = work.source_borrow_scope();
    with_source_stop(scope.resource_stop_handle(), || {
        if matches!(mode, Authority::Both) { account.source_scope(operation) }
        else { operation() }
    })
}

// Keep the measured extractor in one optimized function for every authority
// mode; authority setup must not clone it into distinct benchmark callsites.
#[inline(never)]
fn timed_extract(source: &[u8]) -> ProbeResult<(SymbolicData, u128)> {
    let start = Instant::now();
    let data = extract_symbolic_data(std::hint::black_box(source)).into_outcome()?;
    Ok((data, start.elapsed().as_nanos()))
}

fn main() -> ProbeResult<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("usage: symbolic_probe model.ifc [iterations] [authority]")?;
    let iterations: usize = args.next().unwrap_or_else(|| "5".to_owned()).parse()?;
    let authority_name = args.next().unwrap_or_else(|| "none".to_owned());
    let authority = Authority::parse(&authority_name)?;
    if iterations == 0 || args.next().is_some() {
        return Err("pass a positive iteration count, one fixture and one authority mode".into());
    }
    let capture = std::env::var_os("IFC_LITE_CAPTURE_SYMBOLIC");
    if capture.is_some() && iterations != 1 {
        return Err("full-payload capture requires exactly one untimed witness iteration".into());
    }
    let source = std::fs::read(path)?;
    for iteration in 0..iterations {
        let (data, elapsed_ns) = with_authority(authority, &source, || {
            assert_eq!(ifc_lite_geometry::resource::is_active(),
                matches!(authority, Authority::Account | Authority::Both));
            timed_extract(&source)
        })?;
        let payload = serde_json::to_vec(&data)?;
        let hash = payload.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
        if let Some(path) = &capture { std::fs::write(path, &payload)?; }
        println!("{}", serde_json::json!({
            "iteration": iteration,
            "authority": authority_name,
            "elapsedNs": elapsed_ns,
            "inputBytes": source.len(),
            "polylineCount": data.polylines.len(),
            "circleCount": data.circles.len(),
            "fillCount": data.fills.len(),
            "textCount": data.texts.len(),
            "gridCount": data.grid_axes.len(),
            "symbolicJsonBytes": payload.len(),
            "symbolicJsonFnv1a64": format!("{hash:016x}"),
        }));
    }
    Ok(())
}
