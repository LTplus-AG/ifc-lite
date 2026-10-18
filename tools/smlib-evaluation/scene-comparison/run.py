#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Build one public Rust consumer against pinned existing rlibs, then compare."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def build(pins_path, output):
    pins = json.loads(pins_path.read_text())
    output.mkdir(parents=True, exist_ok=True)
    receipt = {"pins": pins, "harness": {str(p.relative_to(HERE)): sha(p) for p in sorted((HERE / "src").glob("*.rs"))}, "commands": {}}
    for label, libraries in pins["libraries"].items():
        executable = output / ("scene-" + label)
        cmd = ["rustc", "--edition=2021", "-C", "panic=abort", str(HERE / "src/main.rs"), "-L", "dependency=" + str(Path(libraries["ifc_lite_processing"]["path"]).parent), "-o", str(executable)]
        for name, library in libraries.items():
            if sha(library["path"]) != library["sha256"]:
                raise RuntimeError("pinned library changed: " + library["path"])
            cmd += ["--extern", name + "=" + library["path"]]
        receipt["commands"][label] = cmd
        result = subprocess.run(cmd, capture_output=True, text=True)
        (output / (label + "-build.log")).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError("consumer build failed: " + label)
        receipt[label + "_executable_sha256"] = sha(executable)
    current={str(p.relative_to(HERE)):sha(p) for p in sorted((HERE/"src").glob("*.rs"))}
    if current!=receipt["harness"]: raise RuntimeError("harness source changed during build; rebuild both consumers")
    receipt["runner_sha256"]=sha(HERE/"run.py")
    (output / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")

def first_difference(a, b, path="$"):
    if type(a) is not type(b):
        return {"path": path, "base": a, "candidate": b}
    if isinstance(a, dict):
        if a.keys() != b.keys():
            return {"path": path, "base_keys": sorted(a), "candidate_keys": sorted(b)}
        for key in a:
            result = first_difference(a[key], b[key], path + "." + key)
            if result:
                return result
    elif isinstance(a, list):
        if len(a) != len(b):
            return {"path": path, "base_length": len(a), "candidate_length": len(b)}
        for index, (x, y) in enumerate(zip(a, b)):
            result = first_difference(x, y, f"{path}[{index}]")
            if result:
                return result
    elif a != b:
        return {"path": path, "base": a, "candidate": b}
    return None

def compare(base, candidate):
    left = json.loads((base / "manifest.json").read_text())
    right = json.loads((candidate / "manifest.json").read_text())
    if left["input_sha256"] != right["input_sha256"] or left["mode"] != right["mode"]:
        raise RuntimeError("comparison input or request mismatch")
    differences = []
    work_differences = []
    with (base / "records.jsonl").open() as a, (candidate / "records.jsonl").open() as b:
        import itertools
        for ordinal, pair in enumerate(itertools.zip_longest(a, b)):
            if None in pair:
                differences.append({"ordinal": ordinal, "error": "record count differs"})
                break
            x, y = map(json.loads, pair)
            difference = first_difference(x, y)
            if difference:
                entry = {"ordinal": ordinal, "channel": x["channel"], "key": x["key"], "difference": difference}
                (work_differences if x["channel"] == y["channel"] == "execution" else differences).append(entry)
    capability_difference=first_difference(left["capabilities"],right["capabilities"])
    return {"input_sha256": left["input_sha256"], "mode": left["mode"], "equal": not differences and not capability_difference,
            "base_scene_sha256": left["scene_sha256"], "candidate_scene_sha256": right["scene_sha256"],
            "base_witnesses": left["witnesses"], "candidate_witnesses": right["witnesses"],
            "semantic_differences": differences, "execution_differences": work_differences,
            "capability_difference": capability_difference}

def required_witnesses(fixture,mode):
    required={"meshes":1}
    filename=Path(fixture).name
    if filename in ["tessellation-with-blob-texture.ifc","tessellation-with-pixel-texture.ifc"]:
        required.update(uv_meshes=1,pixel_textures=1)
    if filename=="tessellation-with-image-texture.ifc": required.update(uv_meshes=1,url_textures=1)
    if filename=="AC20-FZK-Haus.ifc": required["texts"]=1
    if mode=="fastfirst" and filename in ["tessellation-with-blob-texture.ifc","tessellation-with-pixel-texture.ifc","tessellation-with-image-texture.ifc"]:
        required["color_updates"]=1
    if mode=="instanced" and filename in ["mapped_instances_synthetic.ifc","mapped_instances_site_translated.ifc","mapped_instances_site_rotated.ifc"]:
        required["instances"]=1
    return required

def run(args):
    output = args.output.resolve()
    reports = []
    for fixture in args.fixtures:
        fixture = fixture.resolve()
        if not fixture.is_file():
            reports.append({"fixture": str(fixture), "status": "unavailable; run pnpm fixtures"})
            continue
        for mode in args.modes:
            name = fixture.stem + "-" + sha(fixture)[:12] + "-" + mode
            case = output / name
            for label in ["base", "base-repeat", "candidate"]:
                target = case / label
                target.mkdir(parents=True, exist_ok=True)
                (target/"manifest.json").unlink(missing_ok=True)
                with (case / (label + ".log")).open("w") as log:
                    result = subprocess.run([str(args.bin_dir.resolve() / ("scene-" + ("base" if label=="base-repeat" else label))), str(fixture), str(target), mode],
                                            stdout=log, stderr=log, timeout=args.timeout,
                                            env={**os.environ, "RAYON_NUM_THREADS": str(args.threads)})
                if result.returncode:
                    raise RuntimeError(f"{label} consumer failed for {fixture}: {result.returncode}")
            repeat=compare(case/"base",case/"base-repeat")
            (case/"base-repeat-comparison.json").write_text(json.dumps(repeat,indent=2)+"\n")
            report = compare(case / "base", case / "candidate")
            report["base_reproducible"]=repeat["equal"]
            required=required_witnesses(fixture,mode)
            missing=[label+":"+key for label in ["base","candidate"] for key,value in required.items()
                     if report[label+"_witnesses"].get(key,0)<value]
            report["required_witnesses"]=required
            report["missing_witnesses"]=missing
            report["qualified"]=report["equal"] and repeat["equal"] and not missing
            report["fixture"] = str(fixture)
            (case / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
            reports.append(report)
            print(f"{name}: equal={report['equal']} witnesses={report['candidate_witnesses']}", flush=True)
    output.mkdir(parents=True, exist_ok=True)
    (output / "summary.json").write_text(json.dumps(reports, indent=2) + "\n")
    coverage={key:sum(r.get("candidate_witnesses",{}).get(key,0) for r in reports)
              for key in ["meshes","instances","uv_meshes","pixel_textures","url_textures","layer_meshes","type_meshes","texts","fills","polylines","color_updates","property_sets","materials"]}
    (output/"coverage.json").write_text(json.dumps({"observed_totals":coverage,"unwitnessed":[k for k,v in coverage.items() if not v]},indent=2)+"\n")
    if any(not r.get("qualified", False) for r in reports):
        raise SystemExit(1)

def tests(build_dir):
    receipt=json.loads((build_dir/"build-receipt.json").read_text())
    current={str(p.relative_to(HERE)):sha(p) for p in sorted((HERE/"src").glob("*.rs"))}
    if current!=receipt["harness"]: raise RuntimeError("rebuild consumers after source changes")
    cmd=receipt["commands"]["base"].copy()
    cmd[cmd.index("-o")+1]=str(build_dir/"scene-tests")
    cmd += ["--test","-Z","panic_abort_tests"]
    result=subprocess.run(cmd,capture_output=True,text=True)
    (build_dir/"test-build.log").write_text(result.stdout+result.stderr)
    if result.returncode: raise RuntimeError("test build failed")
    result=subprocess.run([str(build_dir/"scene-tests"),"--nocapture"],capture_output=True,text=True)
    (build_dir/"tests.log").write_text(result.stdout+result.stderr)
    (build_dir/"test-receipt.json").write_text(json.dumps({"command":cmd,"exit":result.returncode,
        "test_executable_sha256":sha(build_dir/"scene-tests"),"log_sha256":sha(build_dir/"tests.log")},indent=2)+"\n")
    print(result.stdout+result.stderr)
    if result.returncode: raise RuntimeError("consumer invariant failed")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("build")
    p.add_argument("--pins", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p = commands.add_parser("tests")
    p.add_argument("--build-dir",type=Path,required=True)
    p = commands.add_parser("run")
    p.add_argument("--bin-dir", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--modes", nargs="+", default=["full", "stream", "instanced", "fastfirst"], choices=["full", "stream", "instanced", "fastfirst"])
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--timeout", type=int, default=300)
    p.add_argument("fixtures", nargs="+", type=Path)
    args = parser.parse_args()
    if args.command=="build": build(args.pins.resolve(),args.output.resolve())
    elif args.command=="tests": tests(args.build_dir.resolve())
    else: run(args)

if __name__ == "__main__":
    main()
