#!/usr/bin/env python3
"""Temporary #6402 provisional-parent native A/B evidence collector."""
import hashlib
import json
import statistics
import subprocess
import sys
from pathlib import Path

base, child, output, *fixtures = map(Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)

def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

result = {"baseBinarySha256": sha(base), "childBinarySha256": sha(child), "fixtures": {}}
if result["baseBinarySha256"] == result["childBinarySha256"]:
    raise SystemExit("base and child binaries are identical; refusing a contaminated comparison")

for fixture in fixtures:
    records = []
    for pair in range(5):
        order = ("base", "child") if pair % 2 == 0 else ("child", "base")
        for side in order:
            binary = base if side == "base" else child
            process = subprocess.run(
                [str(binary.resolve()), str(fixture.resolve()), "--iters", "5", "--json", "--fingerprint"],
                capture_output=True, text=True,
            )
            if process.returncode:
                print(process.stderr, file=sys.stderr)
                raise SystemExit(f"probe failed: {fixture} {side} pair {pair + 1}")
            probe = json.loads(process.stdout)[0]
            hashes = probe["meshFingerprintsFnv1a64"]
            if len(set(hashes)) != 1 or len(hashes) != 5:
                raise SystemExit(f"unstable ordered mesh fingerprint: {fixture} {side} pair {pair + 1}: {hashes}")
            record = {"pair": pair + 1, "side": side, "order": order.index(side) + 1, "probe": probe}
            records.append(record)
            print(f"{fixture.name} pair {pair + 1} {side}: "
                  f"parse={probe['parseMs']} geometry={probe['geometryMs']} total={probe['totalMs']} "
                  f"meshes={probe['meshes']} tris={probe['triangles']} fnv={hashes[0]}", flush=True)
    summary = {"fixtureSha256": sha(fixture), "records": records}
    for side in ("base", "child"):
        subset = [r["probe"] for r in records if r["side"] == side]
        summary[side] = {
            "parseMedianMs": statistics.median(p["parseMs"] for p in subset),
            "geometryMedianMs": statistics.median(p["geometryMs"] for p in subset),
            "totalMedianMs": statistics.median(p["totalMs"] for p in subset),
            "parseRangeMs": [min(p["parseMs"] for p in subset), max(p["parseMs"] for p in subset)],
            "geometryRangeMs": [min(p["geometryMs"] for p in subset), max(p["geometryMs"] for p in subset)],
            "totalRangeMs": [min(p["totalMs"] for p in subset), max(p["totalMs"] for p in subset)],
            "meshes": sorted(set(p["meshes"] for p in subset)),
            "vertices": sorted(set(p["vertices"] for p in subset)),
            "triangles": sorted(set(p["triangles"] for p in subset)),
            "orderedMeshFingerprintsFnv1a64": sorted(set(p["meshFingerprintsFnv1a64"][0] for p in subset)),
        }
    summary["outputIdentity"] = all(
        summary["base"][key] == summary["child"][key]
        for key in ("meshes", "vertices", "triangles", "orderedMeshFingerprintsFnv1a64")
    )
    result["fixtures"][fixture.name] = summary
    (output / f"{fixture.stem}.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"{fixture.name}: outputIdentity={summary['outputIdentity']}", flush=True)

(output / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"binaryHashes": [result["baseBinarySha256"], result["childBinarySha256"]],
                  "fixtureSummaries": {k: {"base": v["base"], "child": v["child"],
                                           "outputIdentity": v["outputIdentity"]}
                                       for k, v in result["fixtures"].items()}}, indent=2))
