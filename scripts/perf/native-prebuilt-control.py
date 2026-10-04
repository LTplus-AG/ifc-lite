# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#6537 real dependency-free ELF controls, not an IFC or timing oracle."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("native_prebuilt", HERE / "native-prebuilt-launcher.py")
launcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = launcher
spec.loader.exec_module(launcher)
PYTHON = os.path.realpath(sys.executable)
C_SOURCE = r'''
#include <sys/stat.h>
#include <unistd.h>
#include <stdio.h>
int main(int argc, char **argv) {
  struct stat s; if (stat("/proc/self/exe", &s)) return 91;
  printf("{\"marker\":\"MARKER\",\"pid\":%ld,\"dev\":\"%llu\",\"ino\":\"%llu\",\"argv\":[",
    (long)getpid(), (unsigned long long)s.st_dev, (unsigned long long)s.st_ino);
  for (int i=0;i<argc;i++) printf("%s\"%s\"", i ? "," : "", argv[i]);
  puts("]}"); return 0;
}
'''


def run(arguments, **options):
    value = subprocess.run(arguments, capture_output=True, text=True, timeout=30, **options)
    assert value.returncode == 0, (arguments, value.returncode, value.stdout, value.stderr)
    assert len(value.stdout.encode()) <= 1024**2 and len(value.stderr.encode()) <= 1024**2
    return value


def prepare():
    directory = Path(tempfile.mkdtemp(prefix="native-fd-control-"))
    try:
        run(["git", "init", "-q", str(directory)])
        (directory / "tracked").write_text("actual owned source\n")
        run(["git", "-C", str(directory), "add", "tracked"])
        run(["git", "-c", "user.name=Native control", "-c", "user.email=control@example.invalid",
             "-C", str(directory), "commit", "-qm", "owned control source"])
        head = run(["git", "-C", str(directory), "rev-parse", "HEAD"]).stdout.strip()
        binary = directory / "target/profiling/examples/perf_probe"
        binary.parent.mkdir(parents=True)
        compiler = os.path.realpath(shutil.which("cc") or "")
        assert os.path.isfile(compiler), "real C compiler required"
        for marker, name in (("held-original", binary.name), ("replacement", "replacement")):
            source = directory / (marker + ".c")
            source.write_text(C_SOURCE.replace("MARKER", marker))
            run([compiler, "-O0", str(source), "-o", str(binary.with_name(name))])
        fixture = directory / "fixture-input"
        fixture.write_bytes(b"ELF control only; not an IFC model\n")
        (directory / "native-results").mkdir()
        info = binary.stat()
        receipt = {"protocol": launcher.POLICY["protocol"], "arm": "base", "revision": head,
                   "directory": str(directory), "controller": {"directory": str(directory), "head": head},
                   "binary": {"path": str(binary), **launcher.identity(info), "sha256": launcher.digest(binary.read_bytes())},
                   "files": launcher.tool_info()["files"], "environment": launcher.environment_binding(),
                   "fixtures": {str(fixture): {"bytes": fixture.stat().st_size, "sha256": launcher.digest(fixture.read_bytes())}}}
        (directory / "receipt.json").write_text(json.dumps(receipt))
        return {"directory": str(directory), "head": head, "binary": str(binary), "fixture": str(fixture),
                "python": PYTHON, "compiler": compiler, "compilerSha256": launcher.digest(Path(compiler).read_bytes())}
    except BaseException:
        shutil.rmtree(directory)
        raise


def receipt_for(directory):
    return json.loads((Path(directory) / "receipt.json").read_text())


def arguments_for(receipt):
    return [next(iter(receipt["fixtures"])), "--iters", "5", "--json", "--fingerprint"]


def refuse(receipt, reason):
    try:
        fd, _ = launcher.validate_receipt(receipt, {"base": receipt_for(receipt["directory"])["revision"]})
    except ValueError as error:
        assert reason in str(error), str(error)
        return
    os.close(fd)
    raise AssertionError("invalid real receipt accepted: " + reason)


def suite():
    prepared = prepare()
    directory = Path(prepared["directory"])
    results = []
    try:
        receipt = receipt_for(directory)
        fd, held = launcher.validate_receipt(receipt, {"base": prepared["head"]})
        os.close(fd)
        assert held == receipt["binary"]
        for kind in ("exec", "replace-exec"):
            value = run([PYTHON, "-I", "-S", "-B", str(Path(__file__).resolve()), kind, str(directory)],
                        cwd=directory, env={**os.environ, "OBS": "0"})
            observed = json.loads(value.stdout)
            assert observed["marker"] == "held-original", observed
            assert (observed["dev"], observed["ino"]) == (held["dev"], held["ino"]), observed
            assert observed["argv"] == [prepared["binary"], *arguments_for(receipt)]
            if kind == "exec":
                witness = json.loads((directory / "native-results/control-intent.json").read_text())
                assert observed["pid"] == witness["process"]["pid"]
                expected = {**witness["process"], "ppid": os.getpid()}
                launcher.verify_witness(receipt, witness, expected, prepared["fixture"])
                for key in ("pid", "pgrp", "startTime", "ppid"):
                    bad = copy.deepcopy(expected)
                    bad[key] = str(bad[key]) + "wrong" if key == "startTime" else bad[key] + 1
                    try:
                        launcher.verify_witness(receipt, witness, bad, prepared["fixture"])
                    except ValueError:
                        continue
                    raise AssertionError("wrong observed owner accepted: " + key)
            results.append({"control": kind, "observed": observed})
        # Replacement demonstrated FD selection. Restore real original bytes for
        # independent whole-validator fences, then account for its new inode.
        run([prepared["compiler"], "-O0", str(directory / "held-original.c"), "-o", prepared["binary"]])
        receipt["binary"] = {"path": prepared["binary"], **launcher.identity(Path(prepared["binary"]).stat()),
                             "sha256": launcher.digest(Path(prepared["binary"]).read_bytes())}
        for key in ("sha256", "ino", "bytes", "path"):
            bad = copy.deepcopy(receipt)
            bad["binary"][key] = 1 if key == "bytes" else "wrong"
            refuse(bad, "canonical profiling probe" if key == "path" else "actual held probe")
        for key, reason in (("revision", "exact declared arm"), ("environment", "environment changed")):
            bad = copy.deepcopy(receipt)
            bad[key] = "wrong" if key == "revision" else {}
            refuse(bad, reason)
        bad = copy.deepcopy(receipt)
        del bad["files"][str(HERE / "native-prebuilt-policy.json")]
        refuse(bad, "consumed interpreter/modules/policy")
        bad = copy.deepcopy(receipt)
        bad["files"][PYTHON] = "0" * 64
        refuse(bad, "frozen runtime file differs")
        Path(prepared["fixture"]).write_bytes(b"different fixture")
        refuse(receipt, "fixture bytes changed")
        Path(prepared["fixture"]).write_bytes(b"ELF control only; not an IFC model\n")
        (directory / "tracked").write_text("dirty source\n")
        refuse(receipt, "source not clean")
        (directory / "tracked").write_text("actual owned source\n")
        for flag in ("--emit", "--fingerprint-wrong"):
            bad_args = arguments_for(receipt)
            bad_args[-1] = flag
            try:
                launcher.execute_receipt(receipt, str(directory / "native-results/unused"), bad_args, {"base": prepared["head"]})
            except ValueError as error:
                assert "fixed probe arguments" in str(error)
                continue
            raise AssertionError("altered actual arguments accepted")
        binary = Path(prepared["binary"])
        saved = binary.read_bytes()
        target = binary.with_name("symlink-target")
        binary.rename(target)
        binary.symlink_to(target)
        try:
            refuse(receipt, "canonical absolute file path")
        finally:
            binary.unlink()
            target.rename(binary)
        binary.write_bytes(b"not an ELF executable\n")
        bad = copy.deepcopy(receipt)
        bad["binary"] = {"path": str(binary), **launcher.identity(binary.stat()), "sha256": launcher.digest(binary.read_bytes())}
        try:
            refuse(bad, "executable ELF required")
        finally:
            binary.write_bytes(saved)
        print(json.dumps({"status": "qualified-functional-ELF-only", "independentExecutions": results,
                          "scope": "real kernel FD selection/PID/argv and receipt refusal controls; no IFC/model/timing"}))
    finally:
        shutil.rmtree(directory)


def main():
    mode = sys.argv[1]
    if mode == "prepare":
        print(json.dumps(prepare()))
    elif mode == "suite":
        suite()
    elif mode in ("exec", "replace-exec"):
        directory = Path(sys.argv[2])
        receipt = receipt_for(directory)
        if mode == "exec":
            launcher.execute_receipt(receipt, str(directory / "native-results/control-intent.json"),
                                     arguments_for(receipt), {"base": receipt["revision"]})
        else:
            fd, _ = launcher.validate_receipt(receipt, {"base": receipt["revision"]})
            try:
                os.replace(str(Path(receipt["binary"]["path"]).with_name("replacement")), receipt["binary"]["path"])
                launcher.exec_held_elf(fd, [receipt["binary"]["path"], *arguments_for(receipt)], dict(os.environ))
            finally:
                os.close(fd)
    else:
        raise ValueError("finite control mode required")


if __name__ == "__main__":
    main()
