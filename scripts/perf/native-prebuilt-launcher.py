# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Private Linux receipt validator and numeric-FD ELF launcher; no path fallback."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

MAX_BINARY = 128 * 1024**2
ENVIRONMENT_KEYS = ("OBS", "RUSTC", "RUSTDOC", "RUSTUP_TOOLCHAIN", "LD_LIBRARY_PATH",
                    "LD_PRELOAD", "LD_AUDIT", "GLIBC_TUNABLES")
POLICY = json.loads(Path(__file__).with_name("native-prebuilt-policy.json").read_text())


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def environment_binding():
    return {key: {"present": key in os.environ,
                  "sha256": digest(os.environ[key].encode()) if key in os.environ else None}
            for key in ENVIRONMENT_KEYS}


def consumed_paths():
    files = {os.path.realpath(sys.executable), str(Path(__file__).resolve()),
             str(Path(__file__).with_name("native-prebuilt-policy.json").resolve())}
    for module in tuple(sys.modules.values()):
        path = getattr(module, "__file__", None)
        if path and os.path.isfile(path):
            files.add(os.path.realpath(path))
    return files


def identity(info):
    return {"dev": str(info.st_dev), "ino": str(info.st_ino),
            "bytes": info.st_size, "mtimeNs": str(info.st_mtime_ns)}


def bounded_file(path, maximum, *, allow_empty=False):
    require(type(path) is str and os.path.isabs(path) and os.path.realpath(path) == path,
            "canonical absolute file path required")
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode) and 0 <= before.st_size <= maximum
            and (allow_empty or before.st_size > 0),
            "bounded regular file required")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(fd)
        require(identity(before) == identity(opened), "file changed during open")
        chunks, remaining = [], opened.st_size
        while remaining:
            data = os.read(fd, min(65536, remaining))
            require(bool(data), "file ended before frozen size")
            chunks.append(data)
            remaining -= len(data)
        require(os.read(fd, 1) == b"", "file grew during read")
        require(identity(os.fstat(fd)) == identity(opened)
                and identity(os.lstat(path)) == identity(opened), "file binding changed")
        return fd, opened, b"".join(chunks)
    except BaseException:
        os.close(fd)
        raise


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate receipt key")
        result[key] = value
    return result


def read_receipt(path, expected_sha):
    fd, _, data = bounded_file(path, 1024**2)
    try:
        require(digest(data) == expected_sha, "receipt SHA differs")
        return json.loads(data, object_pairs_hook=no_duplicate_keys)
    finally:
        os.close(fd)


def git_head(directory):
    require(type(directory) is str and os.path.realpath(directory) == directory
            and os.path.isabs(directory), "canonical source directory required")
    def git(args):
        result = subprocess.run(["git", "-C", directory, *args], capture_output=True,
                                timeout=30, check=True)
        require(len(result.stdout) <= 16 * 1024**2 and len(result.stderr) <= 131072,
                "Git receipt bound")
        return result.stdout.decode().strip()
    require(not git(["status", "--porcelain", "--untracked-files=no"]), "source not clean")
    return git(["rev-parse", "HEAD"])


def validate_receipt(receipt, revisions=None):
    revisions = POLICY["revisions"] if revisions is None else revisions
    require(set(receipt) == {"protocol", "arm", "revision", "directory", "binary",
                            "controller", "files", "environment", "fixtures"}, "receipt schema")
    require(receipt["protocol"] == POLICY["protocol"] and receipt["arm"] in revisions
            and receipt["revision"] == revisions[receipt["arm"]], "exact declared arm required")
    require(git_head(receipt["directory"]) == receipt["revision"], "literal arm source changed")
    controller = receipt["controller"]
    require(set(controller) == {"directory", "head"}
            and git_head(controller["directory"]) == controller["head"], "controller source changed")
    require(receipt["environment"] == environment_binding(), "loader/compiler environment changed")
    require(not os.environ.get("LD_PRELOAD") and not os.environ.get("LD_AUDIT"), "injected loader refused")
    require(os.environ.get("OBS", "0") == "0" and not os.environ.get("CARGO_TARGET_DIR"),
            "default profile/target required")
    files = receipt["files"]
    require(type(files) is dict and 1 <= len(files) <= 512, "runtime closure bound")
    require(consumed_paths() <= files.keys(), "actual consumed interpreter/modules/policy must be frozen")
    for path, sha in files.items():
        fd, _, data = bounded_file(path, MAX_BINARY, allow_empty=True)
        try:
            require(digest(data) == sha, "frozen runtime file differs: " + path)
        finally:
            os.close(fd)
    require(type(receipt["fixtures"]) is dict and 1 <= len(receipt["fixtures"]) <= 3,
            "fixed native fixture set required")
    for path, fixture in receipt["fixtures"].items():
        require(set(fixture) == {"bytes", "sha256"}, "fixture schema")
        fixture_fd, fixture_info, fixture_data = bounded_file(path, 256 * 1024**2)
        try:
            require(fixture_info.st_size == fixture["bytes"]
                    and digest(fixture_data) == fixture["sha256"], "fixture bytes changed")
        finally:
            os.close(fixture_fd)
    binary = receipt["binary"]
    require(set(binary) == {"path", "dev", "ino", "bytes", "mtimeNs", "sha256"}, "binary schema")
    expected_path = str(Path(receipt["directory"]) / "target/profiling/examples/perf_probe")
    require(binary["path"] == expected_path, "canonical profiling probe only")
    fd, info, data = bounded_file(binary["path"], MAX_BINARY)
    try:
        require(data[:4] == b"\x7fELF" and info.st_mode & 0o111, "executable ELF required")
        require(identity(info) == {key: binary[key] for key in identity(info)}
                and digest(data) == binary["sha256"], "actual held probe differs")
        return fd, {**identity(info), "sha256": digest(data), "path": binary["path"]}
    except BaseException:
        os.close(fd)
        raise


def own_process():
    values = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
    return {"pid": os.getpid(), "ppid": os.getppid(), "pgrp": os.getpgrp(),
            "startTime": values[19], "cwd": os.getcwd()}


def exec_held_elf(fd, arguments, environment):
    # An independently reporting ELF control exercises this exact syscall seam.
    # Numeric-FD exec selects the held object, not a subsequently replaced path.
    os.execve(fd, arguments, environment)
    raise RuntimeError("numeric-FD exec unexpectedly returned")


def execute_receipt(receipt, witness, arguments, revisions=None):
    require(sys.platform == "linux" and os.execve in os.supports_fd,
            "Linux numeric-FD execve support required")
    require(len(arguments) == 5 and arguments[0] in receipt["fixtures"]
            and arguments[1:] == ["--iters", "5", "--json", "--fingerprint"], "fixed probe arguments")
    fd, held = validate_receipt(receipt, revisions)
    try:
        require(os.getcwd() == receipt["directory"], "arm source cwd required")
        require(os.path.dirname(witness) == str(Path(receipt["controller"]["directory"]) / "native-results")
                and os.path.isabs(witness), "owned controller artifact path required")
        # This is intent, not a successful-exec receipt. Trusted frozen code,
        # real canonical output and exit, and independent ELF controls complete it.
        row = {"status": "verified-fd-before-exec", "protocol": POLICY["protocol"],
               "held": held, "process": own_process(), "argv": [held["path"], *arguments],
               "environment": environment_binding(), "execApi": "os.execve(numeric-fd)",
               "scope": "held file object; no transient content/whole-machine immutability claim"}
        with open(witness, "x", encoding="utf8") as stream:
            json.dump(row, stream)
            stream.flush()
            os.fsync(stream.fileno())
        require(identity(os.fstat(fd)) == {key: held[key] for key in identity(os.fstat(fd))}
                and identity(os.lstat(held["path"])) == identity(os.fstat(fd)), "held binding changed before exec")
        exec_held_elf(fd, row["argv"], dict(os.environ))
    finally:
        os.close(fd)


def tool_info():
    # -I -S -B isolates imports and forbids bytecode writes. Freeze actual consumed
    # stdlib implementations; frozen/builtin modules are bound to Python itself.
    hashes = {}
    for path in sorted(consumed_paths()):
        fd, _, data = bounded_file(path, MAX_BINARY, allow_empty=True)
        try:
            hashes[path] = digest(data)
        finally:
            os.close(fd)
    return {"python": os.path.realpath(sys.executable), "version": sys.version,
            "supportsFd": os.execve in os.supports_fd, "files": hashes,
            "environment": environment_binding(), "stdlibScope": "actual consumed modules and interpreter; not every installed package"}


def verify_witness(receipt, row, expected, fixture):
    require(set(row) == {"status", "protocol", "held", "process", "argv", "environment", "execApi", "scope"},
            "FD intent witness schema")
    require(row["status"] == "verified-fd-before-exec" and row["protocol"] == POLICY["protocol"]
            and row["execApi"] == "os.execve(numeric-fd)" and row["held"] == receipt["binary"], "FD intent binding")
    require(row["argv"] == [receipt["binary"]["path"], fixture, "--iters", "5", "--json", "--fingerprint"]
            and fixture in receipt["fixtures"] and row["environment"] == receipt["environment"], "FD intent inputs")
    process = row["process"]
    require(set(process) == {"pid", "ppid", "pgrp", "startTime", "cwd"}
            and all(process[key] == expected[key] for key in ("pid", "pgrp", "startTime", "ppid"))
            and process["cwd"] == receipt["directory"], "FD launcher actual owned process binding")
    return {"status": "verified-fd-intent-owned-binding", "process": process,
            "scope": "intent only; canonical result/exit and qualified syscall controls required"}


def main():
    mode = sys.argv[1]
    if mode == "tools" and len(sys.argv) == 2:
        print(json.dumps(tool_info()))
        return
    require(mode in ("validate", "exec", "witness"), "fixed private launcher mode required")
    receipt = read_receipt(sys.argv[2], sys.argv[3])
    if mode == "validate":
        require(len(sys.argv) == 4, "validation arguments")
        fd, held = validate_receipt(receipt)
        os.close(fd)
        print(json.dumps({"status": "validated-fd-receipt", "held": held}))
    elif mode == "exec":
        require(len(sys.argv) == 10, "execution arguments")
        execute_receipt(receipt, sys.argv[4], sys.argv[5:])
    else:
        require(len(sys.argv) == 8, "witness arguments")
        row = read_receipt(sys.argv[4], sys.argv[5])
        expected = json.loads(sys.argv[6], object_pairs_hook=no_duplicate_keys)
        print(json.dumps(verify_witness(receipt, row, expected, sys.argv[7])))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        text = str(error).encode("utf8")
        reason = text[:4096].decode("utf8", errors="ignore")
        print(json.dumps({"status": "refused", "reason": reason, "reasonIsPrefix": len(text) > 4096}), file=sys.stderr)
        sys.exit(1)
