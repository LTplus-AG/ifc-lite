# Server operations: admission control and memory

The parse endpoints buffer the whole upload (default cap 500 MB) and spawn
blocking decode/mesh work whose peak working set is a multiple of the file
size. Admission control bounds how much of that runs at once so concurrent
large uploads return `503 Retry-After` instead of OOM-killing the (single)
replica.

## Knobs (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `IFC_MAX_CONCURRENT_PARSES` | `WORKER_THREADS` (= cores) | Parse jobs running at once (CPU gate) |
| `IFC_MEM_BUDGET_MB` | 70% of the tightest readable ceiling (cgroup, else physical RAM), else 0 | Total admitted upload bytes at once; `0` is an explicit opt-out that disables the byte gate |
| `IFC_ADMISSION_QUEUE_DEPTH` | `2 * WORKER_THREADS` | Requests allowed to wait for a slot before immediate 503 |
| `IFC_ADMISSION_QUEUE_TIMEOUT_SECS` | `5` | Longest a queued request waits before 503 |
| `IFC_MEM_SHED_PCT` | `85` | RSS percentage of the budget above which new work is shed |
| `IFC_METRICS_ENABLED` | off | Expose `GET /api/v1/metrics` (Prometheus text; behind the bearer token when one is set) |

Each admitted parse reserves the full `MAX_FILE_SIZE_MB` against the byte
budget (multipart rarely declares a length up front), so the budget divided by
the max file size is the number of large parses that can run concurrently.

## Sizing rule

Budget roughly `file_size x (1x upload buffer + 3-6x decode/mesh working set)`
for geometry-heavy models; the multiplier is workload-dependent, re-measure on
your corpus. Concretely for a single-replica box:

- `IFC_MEM_BUDGET_MB` defaults to 70% of the tightest readable memory ceiling:
  the cgroup limit inside containers, or physical RAM on a bare VM, so the
  memory gate is active out of the box on both. Only when neither is readable
  (non-Linux, or `/proc` unavailable) does it fall back to `0` (gate off), which
  the server logs a startup `WARN` about. Set it explicitly to override, or to
  `0` to opt out deliberately. Caveat: the physical-RAM fallback reads
  `/proc/meminfo` `MemTotal`, which is HOST-wide. In a container run with **no**
  cgroup memory limit, that budget reflects the whole host, not the pod's usable
  RAM, so set `IFC_MEM_BUDGET_MB` explicitly (or give the container a memory
  limit) in that case,
- keep `IFC_MAX_CONCURRENT_PARSES` at the core count,
- lower `MAX_FILE_SIZE_MB` below 500 unless the box has multiple GB of
  headroom per concurrent slot,
- front the deployment with an edge rate limiter when it is internet-facing
  and unauthenticated (see the startup warning).

## Probes

- `GET /api/v1/health` - liveness. Static, never load-gated. Railway's
  `healthcheckPath` points here; do NOT repoint it at readiness or the box
  restart-loops exactly when it is busiest.
- `GET /api/v1/ready` - readiness. Returns 503 while the RSS breaker is
  shedding, so an external balancer can drain the instance.
- `GET /api/v1/metrics` - admission gauges/counters + resident memory
  (`ifc_server_resident_bytes`, `ifc_server_admission_in_flight`,
  `ifc_server_admission_queued`, `ifc_server_admission_rejected_total{reason}`,
  `ifc_server_mem_budget_bytes`), plus cache size gauges
  (`ifc_server_cache_entries`, `ifc_server_cache_bytes`), when
  `IFC_METRICS_ENABLED=1`.

## Cache

The disk cache (`CACHE_DIR`) has no size limit and NEVER self-prunes.
`CACHE_MAX_AGE_DAYS` is parsed into `Config` and read by nothing else -- no
code path evicts on age, so an entry written today is still there next year
unless something removes it. `DELETE /api/v1/cache/{sha256}` is the only
removal path the server offers (short of deleting `CACHE_DIR` on disk). It
removes every cache entry derived from one source file's content hash (the
request, `-json-v2`, `-parquet-vN`, `-parquet-metadata-vN` and `-symbolic-v1`
entries, across every opening-filter/tessellation-quality combination) and
reclaims any content blob none of them, or any unrelated entry, still
references. It
is idempotent: deleting a hash nothing is cached under is a `200` with
`{"deleted": 0}`, not a `404`, so a caller can invoke it unconditionally (e.g.
"the model behind this hash was removed, drop whatever is cached for it")
without checking existence first. Use it to bound cache size from an
external job, or to invalidate the geometry for a model an application has
deleted.

Like every other route, `DELETE` is UNAUTHENTICATED when
`IFC_SERVER_API_TOKEN` is unset -- anyone who can reach the port can empty
the cache hash by hash. Set the token on any deployment whose port is not
already private.

`DELETE` does not cancel or outrank an in-flight parse for the same hash: a
cache fill that is already running (or queued behind the reclaim lock)
re-inserts its entries after the `200` returns. If you are invalidating
because the source bytes changed, note that different bytes hash to a
different key anyway; if you are invalidating to reclaim space, re-issue the
`DELETE` once the in-flight parse has finished.

## Behavior notes

- RSS sampling reads `/proc/self/statm` every 500 ms (Linux; the breaker is
  inert on other platforms - the semaphores still bound admissions there). The
  allocator was deliberately NOT swapped to jemalloc: the release matrix
  includes a musl target where that is a known build risk; the RSS source
  lives behind `admission::resident_bytes_now()` if that decision is revisited.
- SSE disconnects cancel the parse at the next batch boundary
  (`StreamingOptions::cancel`), freeing the core and the admission slot early.
  Synchronous (non-streaming) parses run to completion; their admission slot
  is held the whole time so a replacement is not admitted on top of a zombie.
- Per-client rate limiting (429) is not built in; the admission gate is
  per-process. Front with an edge limiter for per-IP fairness.
