# C4-14 symbolic style index: one scan (#8341, PROCESSING-SYM-18)

`build_styled_item_index` scanned the whole file twice, once for
`IFCPRESENTATIONSTYLEASSIGNMENT` and once for `IFCSTYLEDITEM`. One scan now
records both spans. Decoding still runs every wrapper before any styled item, in
file order, so the decoder cache sees the same call sequence (this matters
only for duplicate ids, where the cache decides which record a later lookup
returns) and the index is unchanged.

## Instruction counts

Callgrind 3.26.0 on Pop, `symbolic_probe <fixture> 1` built with
`--profile profiling`, `--toggle-collect='*timed_extract*'` (the
`#[inline(never)]` extraction call only; reading the file and hashing the JSON
are outside it). One run per side: instruction counts do not depend on load.

| fixture | PSA / styled items | base Ir | head Ir | delta | symbolic JSON (bytes, FNV-1a 64) |
|---|---|---:|---:|---:|---|
| AC20-FZK-Haus | 79 / 393 | 198,375,436 | 169,628,885 | -14.49% | 50,987 `fb41ad46ecef8798` both |
| ISSUE_034_HouseZ | 401 / 401 | 323,097,526 | 274,774,227 | -14.96% | 66 `18f7e9a8a6c02daf` both |
| dental_clinic | 26 / 2,083 | 947,543,913 | 809,305,824 | -14.59% | 783,425 `1d7ce6dfeced757c` both |
| duplex | 267 / 267 | 174,809,788 | 149,223,471 | -14.64% | 102,787 `38e8b670333c4837` both |
| schependomlaan | 48 / 2,563 | 3,150,211,916 | 2,610,492,259 | -17.13% | 223,729 `e5d2983d3c9e98d3` both |

Base source: `origin/main` `1a3d4a83a7` plus a local-only measurement driver
commit. Head source: this change (`41b95cb72b`) on the same base plus the same
driver. The head arm was a local merge with the separately measured, declined
opening-filter candidate, which touches only `processor/` and is not reachable
from `extract_symbolic_data`. Fleet requests
`auto-41f2f269f4544f30823a928f973ee57d` (base, job `875c2cb5`) and
`auto-298a223607894120a5600a51eff26255` (head, job `4c137171`).

The saving is one full `EntityScanner` pass. Entity scans dominate symbolic
extraction (see the #7914 ledger entry), which is why one pass is roughly a
seventh of the extraction.

## Native pipeline

`process_geometry` never calls the symbolic extractor.
`scripts/perf/instructions.sh` on this change alone (local-only driver
commit `0a6698498f`, fleet request `auto-331fc3bab0e64643bb427d77e09ff4f3`,
job `60def880`) against the base run above:

| fixture | parse | entity scan | lookup | preprocess | geometry | total | meshes / vertices / triangles |
|---|---:|---:|---:|---:|---:|---:|---|
| AC20-FZK-Haus | -5 | 0 | 0 | -5 | -101 | -106 | 285 / 35,940 / 20,322 both |
| duplex | -21 | 0 | 0 | -21 | +41 | +20 | 486 / 51,578 / 30,374 both |

Every phase is within 1.000001 of base (absolute Ir deltas shown).

## Scope

Instruction counts only. No wall-time, browser or worker-pool claim: the
valgrind-hosted `elapsedNs` values in the raw probe output are not timings.
