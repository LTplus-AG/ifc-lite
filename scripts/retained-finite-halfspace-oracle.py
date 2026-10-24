#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 independently invoked finite-domain semantic mutations; admitted execution only."""
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
PREFIX = pathlib.Path("rust/geometry/src/program/retained")
TEST = "program::inner::retained_program::tests::finite_tests::j1_finite_membership_oracle"


def witness(mutated=False):
    result = subprocess.run(
        ["cargo", "test", "--locked", "-p", "ifc-lite-geometry", "--lib", TEST,
         "--", "--exact", "--nocapture"], cwd=ROOT, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900)
    print(result.stdout, end="", flush=True)
    if mutated:
        if result.returncode != 101 or "FINITE_MEMBERSHIP" not in result.stdout or "1 failed" not in result.stdout:
            raise RuntimeError("mutation did not fail the independent membership assertion")
    elif result.returncode != 0 or "1 passed" not in result.stdout:
        raise RuntimeError("positive finite source control did not execute and pass")


def main():
    mutations = [
        ("default-small-direction", "finite_source.rs", "let frame = super::finite_frame::frame(&source)?;", "let frame = crate::processors::helpers::parse_axis2_placement_3d(position, decoder)?;"),
        ("omit-boundary", "finite_clip.rs", "planes.into_iter().enumerate()", "planes.into_iter().enumerate().take(0)"),
        ("ignore-box-corner", "finite_clip.rs", "let mut point = corner.values;", "let mut point = [0.;3];"),
        ("double-box-dimensions", "finite_clip.rs", "point[axis] += dimensions[axis];", "point[axis] += 2.*dimensions[axis];"),
        ("ignore-units", "finite_clip.rs", "let s = template.source.length_unit_scale;", "let s = 1.;"),
        ("lose-concavity", "finite_partition.rs", "if (0..n).all(", "if true || (0..n).all("),
        ("reuse-base-side", "clip.rs", "self.finite.as_ref().is_none_or(|f| f.is_base()) && self.source.agreement", "self.source.agreement"),
    ]
    paths = sorted({str(PREFIX / file) for _, file, _, _ in mutations})
    subprocess.run(["git", "diff", "--exit-code", "HEAD", "--", *paths], cwd=ROOT, check=True)
    witness()
    for name, file, old, new in mutations:
        path = ROOT / PREFIX / file
        original = path.read_bytes()
        source = original.decode()
        if source.count(old) != 1:
            raise RuntimeError(f"mutation anchor is not unique: {name}")
        try:
            path.write_text(source.replace(old, new))
            witness(mutated=True)
            print(f"OBSERVED FINITE: {name}", flush=True)
        finally:
            path.write_bytes(original)
        witness()


if __name__ == "__main__":
    main()
