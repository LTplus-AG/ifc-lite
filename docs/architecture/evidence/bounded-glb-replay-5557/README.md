# Bounded GLB replay screen (#5557)

**Verdict: evidence only; no runtime change ships.** A native Linux prototype recorded the planning pass's meshes in an unlinked scratch file and replayed them through the existing bounded GLB writer, avoiding the second meshing pass. On three fixtures, two balanced A/B pairs each completed with identical full GLB SHA-256 and coverage counts. This establishes a promising *native forced-bounded* mechanism, not a production improvement or a browser/CLI/MCP speedup.

The first-party CLI and MCP use `GeometryProcessor.exportGlb` through WASM. The viewer's source-byte GLB export uses that same WASM API, while its loaded-mesh export uses `exportGlbFromMeshes`. No first-party native server, CLI, FFI or PyO3 GLB caller was found. A new native-only public scratch API would therefore have no current first-party consumer. The prototype is intentionally absent from production source after this PR.

## Controlled screen

Base commit: `d05f5423a7caf761f0a2e12d064d85e84355d031`. Both binaries used the same `bounded_spike` example and pinned profiling toolchain. The baseline has only [example.patch](example.patch); the candidate additionally has [replay-only.patch](replay-only.patch). The archived #5357 patch's unrelated processing/georeferencing experiment was not applied. [protocol.json](protocol.json) records source, binary and fixture hashes, toolchain, affinity, observer provenance, and the UTC window. [runs.jsonl](runs.jsonl) has every run's output timing, process timing, peak RSS, artifact hash and coverage counts; [summary.json](summary.json) is derived from those rows.

| Fixture | Baseline output time (ms) | Replay output time (ms) | Observed median reduction | Peak RSS baseline / replay (KiB) |
| --- | ---: | ---: | ---: | ---: |
| Holter | 9,059 / 8,863 | 5,030 / 4,962 | 44.2% | 863,548 / 873,908 vs 785,060 / 792,436 |
| ISSUE_129 CSG | 3,683 / 3,844 | 1,852 / 1,918 | 49.9% | 124,156 / 126,288 vs 97,936 / 97,368 |
| AC20 Haus | 71.9 / 74.9 | 38.7 / 33.9 | 50.5% | 23,616 / 23,232 vs 23,040 / 22,656 |

All 12 runs exited zero, all six A/B pairs had matching complete GLB SHA-256 and mesh/vertex/triangle/material counts, and no scratch pathname remained. Output time includes source read, bounded export, and output-file write, but not post-run SHA-256. GNU time's process wall duration includes process startup and hashing. Source files and generated GLBs are not committed. The three original IFCs are catalogued under `tests/models/manifest.json` and their hashes are pinned in the protocol.

The screen used Linux WSL ext4, `RAYON_NUM_THREADS=12`, benchmark affinity CPUs 4–23, and a controlled 09:58:39–09:59:53 UTC window on 2026-09-24. Thirty-five competing processes were temporarily pinned to CPU 0; the watchdog restored 652 live threads afterward, with zero affinity mismatches in the restoration audit. OS page cache was not controlled. Two pairs per fixture are a screening cohort, below the five-iteration performance qualification expected for a shipping optimization.

## Reproduce

The original measuring script is retained outside the repo; its SHA-256 is pinned in the protocol. [screen.py](screen.py) is a portable-path equivalent: it takes the fixture root, binaries, CPU list and output directory as arguments, refuses existing output directories, runs balanced pairs in fresh processes, hashes each complete GLB, records GNU time RSS, and deletes a fixture's output artifacts only after all its hashes agree. Failed attempts retain a row with an `observerError` and null measurements where collection failed. Linux `taskset` and `/usr/bin/time` are required.

```sh
# Copy this evidence bundle outside the worktree before checking out the pinned
# base; that older commit does not contain these archive files.
cp -a docs/architecture/evidence/bounded-glb-replay-5557 /path/to/evidence-bundle
git checkout d05f5423a7caf761f0a2e12d064d85e84355d031
# Use a task-specific Cargo target directory.
git apply /path/to/evidence-bundle/example.patch
CARGO_TARGET_DIR=/path/to/cargo-target CARGO_BUILD_JOBS=8 cargo build --profile profiling -p ifc-lite-export --example bounded_spike
cp /path/to/cargo-target/profiling/examples/bounded_spike /path/to/base-probe

git apply /path/to/evidence-bundle/replay-only.patch
CARGO_TARGET_DIR=/path/to/cargo-target CARGO_BUILD_JOBS=8 cargo build --profile profiling -p ifc-lite-export --example bounded_spike
cp /path/to/cargo-target/profiling/examples/bounded_spike /path/to/replay-probe

python3 /path/to/evidence-bundle/screen.py \
  --base /path/to/base-probe --candidate /path/to/replay-probe \
  --fixture-root /path/to/tests/models --out /path/to/new-screen-output \
  --cpus 4-23 --rayon-threads 12 --pairs 2
```

After copying the candidate binary, reverse the replay and example patches to restore the checkout. The benchmark sets `IFC_SPIKE_SPOOL` only for candidate processes; the prototype's default remains the existing two-pass path. The scratch file is created exclusively and unlinked immediately on Linux.

## Why the prototype stops here

Holter's scratch stream was **152,933,591 bytes** for a **42,177,720-byte** final GLB. A small in-memory WASM replay budget would fall back to remeshing on that model; a budget large enough to retain the stream would raise peak WASM memory alongside the input, output, index and active geometry batches, undermining the bounded export's OOM protection. A different compact replay representation needs its own design and measured memory ceiling.

The archive still contains deliberate `expect`/`unwrap` calls for scratch I/O, Linux-only unlink behavior, and no supported scratch-capacity or permission contract. Portable I/O fault handling, browser/WASM re-opening, and five-pair shipping qualification were **not performed**, because the prototype has no current first-party native consumer. The prior [#5357 archive](https://github.com/LTplus-AG/ifc-lite/blob/d05f5423a7caf761f0a2e12d064d85e84355d031/scripts/perf/evidence/export-delivery-5357/README.md) contains broader artifact-parity observations and the original combined experiment.
