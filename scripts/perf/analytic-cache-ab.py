#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""#6442 fresh-process, test-only mapped analytic cache A/B measurement.

Build once: cargo test --release -p ifc-lite-processing --lib --no-run
Then: python3 scripts/perf/analytic-cache-ab.py --binary target/release/deps/ifc_lite_processing-<hash> --snowdon 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc' --output /tmp/analytic-cache-ab.json
The binary must be the executable Rust unit-test target, not its .d file.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import statistics
import subprocess
import tempfile

MARKER = "ANALYTIC_CACHE_MEASURE "
TEST = "issue_6442_analytic_cache_process_measurement"
EXPECTED = {
    "snowdon": {"cache": 128, "control": 1073, "description_occurrences": 149,
                "extrusion_occurrences": 911},
    "many": {"cache": 1, "control": 1024, "description_occurrences": 1024,
             "extrusion_occurrences": 0},
    "nested": {"cache": 2, "control": 6, "description_occurrences": 4,
               "extrusion_occurrences": 0},
}


def run(binary, snowdon, fixture, mode, payload_path):
    env = os.environ.copy()
    env.update(IFC_LITE_ANALYTIC_FIXTURE=fixture, IFC_LITE_ANALYTIC_MODE=mode,
               IFC_LITE_ANALYTIC_SNOWDON=str(snowdon), IFC_LITE_ANALYTIC_OUTPUT=str(payload_path))
    process = subprocess.run([str(binary), TEST, "--ignored", "--nocapture"],
                             env=env, capture_output=True, text=True, check=False)
    if process.returncode:
        raise RuntimeError(f"{fixture}/{mode}: exit {process.returncode}\n{process.stdout}\n{process.stderr}")
    lines = [line.split(MARKER, 1)[1] for line in process.stdout.splitlines() if MARKER in line]
    if len(lines) != 1:
        raise RuntimeError(f"expected one measurement, got {len(lines)}:\n{process.stdout}")
    record = json.loads(lines[0])
    payload = payload_path.read_bytes()
    record["sha256"] = hashlib.sha256(payload).hexdigest()
    if record["output_bytes"] != len(payload):
        raise RuntimeError("reported payload length differs from file")
    return record, payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=pathlib.Path, required=True)
    parser.add_argument("--snowdon", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if not args.binary.is_file() or not os.access(args.binary, os.X_OK):
        parser.error("--binary must be an executable test binary")
    snowdon = args.snowdon.resolve()
    if not snowdon.is_file():
        parser.error("Snowdon missing; run pnpm fixtures")
    snowdon_hash = hashlib.sha256(snowdon.read_bytes()).hexdigest()
    if snowdon_hash != "fab102eb5f9152bc7053d7e4920a8b75d0d34683c834078f0735c88308eb00a4":
        parser.error("Snowdon checksum differs from tests/models/manifest.json")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    rustc = subprocess.check_output(["rustc", "--version"], text=True).strip()
    evidence = {"issue": 6442, "git_head": source, "rustc": rustc,
                "host": platform.platform(), "machine": platform.machine(),
                "binary_sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
                "snowdon_sha256": snowdon_hash,
                "method": "five balanced interleaved pairs, fresh test process per mode; IFC read before timed analytic call; 1 ms VmRSS sampling; standalone index sample and serialization after call; OS file cache unpurged",
                "fixtures": {}}
    with tempfile.TemporaryDirectory(prefix="analytic-cache-ab-") as directory:
        payload_path = pathlib.Path(directory) / "ordered.json"
        for fixture in ("snowdon", "many", "nested"):
            runs = []
            reference = None
            for pair in range(5):
                order = ("control", "cache") if pair % 2 == 0 else ("cache", "control")
                for mode in order:
                    record, payload = run(args.binary, snowdon, fixture, mode, payload_path)
                    expected = EXPECTED[fixture]
                    for key, wanted in (("source_loads", expected[mode]),
                                        ("description_occurrences", expected["description_occurrences"]),
                                        ("extrusion_occurrences", expected["extrusion_occurrences"])):
                        if record[key] != wanted:
                            raise RuntimeError(f"{fixture}/{mode}: {key}={record[key]}, expected {wanted}")
                    record["pair"] = pair + 1
                    if reference is None:
                        reference = payload
                    elif payload != reference:
                        raise RuntimeError(f"{fixture} ordered analytic JSON differs at pair {pair + 1}, mode {mode}")
                    runs.append(record)
                    print(f"{fixture} pair {pair + 1} {mode}: {record['elapsed_ns']/1e6:.2f} ms, "
                          f"{record['peak_rss_kib']} KiB, {record['source_loads']} source loads", flush=True)
            cache = [record for record in runs if record["mode"] == "cache"]
            control = [record for record in runs if record["mode"] == "control"]
            deltas_ms = [(cache[i]["elapsed_ns"] - control[i]["elapsed_ns"]) / 1e6 for i in range(5)]
            summary = {"cache_median_ms": statistics.median(r["elapsed_ns"] / 1e6 for r in cache),
                       "control_median_ms": statistics.median(r["elapsed_ns"] / 1e6 for r in control),
                       "paired_cache_minus_control_ms": deltas_ms,
                       "cache_peak_rss_kib": [r["peak_rss_kib"] for r in cache],
                       "control_peak_rss_kib": [r["peak_rss_kib"] for r in control],
                       "ordered_output_identical": True}
            evidence["fixtures"][fixture] = {"summary": summary, "runs": runs}
            print(f"{fixture}: {summary}", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"evidence: {args.output}", flush=True)


if __name__ == "__main__":
    main()
