#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 SDK lane of the reverse-applied .oracle.patch convention.

Run ONLY inside parent admission after configuring/building the native target.
The central revert runner has no C++ runtime adapter. Require green controls,
then an exact semantic assertion (never a compile error, crash or timeout).
"""
import pathlib
import subprocess
import sys


def run(root, *args):
    subprocess.run(args, cwd=root, check=True)


def witness(root, binary, case, marker=None):
    result = subprocess.run([str(binary), case], cwd=root, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    print(result.stdout, end="", flush=True)
    if marker is None:
        if result.returncode != 0 or "plane oracle PASS" not in result.stdout:
            raise RuntimeError(f"unmutated {case} is not green")
    elif result.returncode != 1 or f"plane oracle FAIL: {marker}" not in result.stdout:
        raise RuntimeError(f"{case}: semantic mutation was not killed by its intended assertion")


def chain_witness(root, binary, marker=None):
    result = subprocess.run([str(binary), "proof"], cwd=root, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    print(result.stdout, end="", flush=True)
    if marker is None:
        if result.returncode != 0 or "plane chain PASS" not in result.stdout:
            raise RuntimeError("unmutated chain proof is not green")
    elif result.returncode != 1 or f"plane chain FAIL: {marker}" not in result.stdout:
        raise RuntimeError("chain mutation was not killed by its intended assertion")


def chain_mutations(root, build):
    binary = build / "ifclite_smlib_plane_chain_tests"
    target = "ifclite_smlib_plane_chain_tests"
    chain_witness(root, binary)
    for name, marker in (
        ("chain-affine-bound", "affine extension bounds both outside endpoints"),
        ("chain-domain-bound", "actual domain includes present UV image"),
        ("chain-affine-proof", "warped rectangle cannot supply missing trim proof"),
    ):
        patch = pathlib.Path(__file__).parent / "fixtures" / f"{name}.oracle.patch"
        run(root, "git", "apply", "--reverse", "--check", str(patch))
        run(root, "git", "apply", "--reverse", str(patch))
        try:
            run(root, "cmake", "--build", str(build), "--target", target, "--parallel", "2")
            chain_witness(root, binary, marker)
            print(f"OBSERVED: {name}", flush=True)
        finally:
            run(root, "git", "apply", str(patch))
            run(root, "git", "diff", "--exit-code", "HEAD", "--", "native/smlib-adapter")
            run(root, "cmake", "--build", str(build), "--target", target, "--parallel", "2")
        chain_witness(root, binary)


def main():
    root = pathlib.Path(__file__).resolve().parents[3]
    build = pathlib.Path(sys.argv[1]).resolve()
    binary = build / "ifclite_smlib_plane_oracle_tests"
    target = "ifclite_smlib_plane_oracle_tests"
    run(root, "git", "diff", "--exit-code", "HEAD", "--", "native/smlib-adapter")
    for case in ("cylinder", "patch", "patch-edge"):
        witness(root, binary, case)
    mutations = (
        ("cylinder-radial", "cylinder", "cylinder face-only extrema enclosure"),
        ("cylinder-axial", "cylinder", "cylinder face-only extrema enclosure"),
        ("patch-success", "patch", "generic method2 clip must succeed"),
        ("patch-construction-accuracy", "patch-edge", "retained patch edge respects fixed source graph accuracy"),
    )
    for name, case, marker in mutations:
        patch = pathlib.Path(__file__).parent / "fixtures" / f"{name}.oracle.patch"
        run(root, "git", "apply", "--reverse", "--check", str(patch))
        run(root, "git", "apply", "--reverse", str(patch))
        try:
            run(root, "cmake", "--build", str(build), "--target", target, "--parallel", "2")
            witness(root, binary, case, marker)
            if name == "patch-construction-accuracy":
                # Same bypass must also reproduce the original observed failure,
                # independently of the new retained-edge oracle.
                witness(root, binary, "patch", "source graph and clipping halfspace containment")
            print(f"OBSERVED: {name}", flush=True)
        finally:
            run(root, "git", "apply", str(patch))
            run(root, "git", "diff", "--exit-code", "HEAD", "--", "native/smlib-adapter")
            run(root, "cmake", "--build", str(build), "--target", target, "--parallel", "2")
        witness(root, binary, case)
        if name == "patch-construction-accuracy":
            witness(root, binary, "patch")

    chain_mutations(root, build)


if __name__ == "__main__":
    main()
