#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 independent owned-domain bounds/report mutations; parent admission only."""
import pathlib
import subprocess
import sys


def run(root, *args):
    subprocess.run(args, cwd=root, check=True)


def witness(root, binary, marker=None):
    r = subprocess.run([str(binary)], cwd=root, text=True, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, timeout=60)
    print(r.stdout, end="", flush=True)
    if marker is None:
        if r.returncode != 0 or "plane owned PASS" not in r.stdout:
            raise RuntimeError("unmutated owned domain control is not green")
    elif r.returncode != 1 or f"plane owned FAIL: {marker}" not in r.stdout:
        raise RuntimeError("owned domain mutation missed its intended semantic assertion")


def main():
    root = pathlib.Path(__file__).resolve().parents[3]
    build = pathlib.Path(sys.argv[1]).resolve()
    target = "ifclite_smlib_plane_owned_tests"
    binary = build / target
    run(root, "git", "diff", "--exit-code", "HEAD", "--", "native/smlib-adapter")
    witness(root, binary)
    for name, marker in (
        ("owned-domain-bound", "owned bound covers complete reconstructed UV image"),
        ("owned-domain-report", "owned reconstruction must report method8"),
        ("owned-domain-seal", "one ULP invalidates sealed inventory"),
        ("owned-domain-opposite", "opposite loopuse orientation invalidates sealed inventory"),
    ):
        patch = pathlib.Path(__file__).parent / "fixtures" / f"{name}.oracle.patch"
        run(root, "git", "apply", "--reverse", "--check", str(patch))
        run(root, "git", "apply", "--reverse", str(patch))
        try:
            run(root, "cmake", "--build", str(build), "--target", target, "--parallel", "2")
            witness(root, binary, marker)
            print(f"OBSERVED OWNED: {name}", flush=True)
        finally:
            run(root, "git", "apply", str(patch))
            run(root, "git", "diff", "--exit-code", "HEAD", "--", "native/smlib-adapter")
            run(root, "cmake", "--build", str(build), "--target", target, "--parallel", "2")
        witness(root, binary)


if __name__ == "__main__":
    main()
