# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Checked reference conversion in an owned process (#7723).

The engine's detailed logger writes native stdout, not just get_log(). Keep
that process-global setting out of callers and retain each conversion's log.
Only terminal Boolean failure is rejected: a failed retry may later succeed.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import time

MAX_LOG_BYTES = 32 * 1024 * 1024
CALL_SECONDS = 120
SUPPORTED_ENGINE = "0.8.5"
TERMINAL_MESSAGES = (
    "No longer attempting boolean operation with higher fuzziness",
    "Invalid operands. Using first operand",
)


class InvalidReference(RuntimeError):
    """A returned mesh cannot be admitted as a reference."""


class ShapeUnavailable(RuntimeError):
    """Ordinary conversion failure; retain the existing explicit skip contract."""


def diagnostics(text: str) -> dict:
    """Separate terminal fallback from transient retry notices and valid no-ops."""
    records, unstructured = [], []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            unstructured.append(line)
            continue
        if isinstance(row, dict) and isinstance(row.get("message"), str):
            records.append({k: row[k] for k in ("level", "message", "instance") if k in row})
        else:
            unstructured.append(line)
    terminal = [r for r in records if any(m in r["message"] for m in TERMINAL_MESSAGES)]
    # A new error class must be investigated, not silently accepted as an oracle.
    errors = [r for r in records if str(r.get("level", "")).lower() in ("error", "fatal")]
    progress = {"Scanning file...", "Done scanning file", "Done resolving references"}
    incomplete = [s for s in unstructured if s.strip() not in progress
                  and re.fullmatch(r"#\d+", s.strip()) is None]
    return {"records": records, "unstructured": unstructured, "unresolvedLogLines": incomplete,
            "terminalBooleanFailure": terminal, "errors": errors,
            "referenceUsable": not terminal and not errors and not incomplete}


class ReferenceSession:
    """Parse once; returned arrays remain provisional until successful close.

    A native stream can flush after a response. The final admission barrier
    revalidates all complete logs after worker exit, before callers publish.
    """

    def __init__(self, fixture: Path, settings: dict, output: Path):
        self.output = output.resolve()
        try:
            self.output.mkdir(parents=True, exist_ok=False)
        except FileExistsError as error:
            raise InvalidReference(f"{self.output} exists; use a fresh output directory") from error
        self.sequence = 0
        self.pending = b""
        self.closed = False
        self.failure = None
        self.records = []
        self.fixture = fixture.resolve()
        self.fixture_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
        self.settings = settings
        self.stderr = (self.output / "worker-stderr.log").open("wb")
        self.child = subprocess.Popen(
            [sys.executable, "-B", str(Path(__file__).with_name("reference_worker.py")), str(self.output)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
        )
        try:
            response = self._request({"fixture": str(fixture.resolve()), "settings": settings})
            self.initialization_response = response
            if response["status"] != "ready":
                raise InvalidReference("Reference initialization failed; retained diagnostics")
            self.products = json.loads((self.output / "products.json").read_bytes())
            self.engine = response["engine"]
            if self.engine != SUPPORTED_ENGINE:
                raise InvalidReference(f"Unsupported reference engine {self.engine}; expected {SUPPORTED_ENGINE}")
            init_log = (self.output / "1-engine.log").read_text(errors="replace")
            if not diagnostics(init_log)["referenceUsable"]:
                raise InvalidReference("Reference initialization diagnostics are unresolved")
        except BaseException as error:
            self.failure = repr(error)
            self.close()
            raise

    def _check_log_bounds(self):
        logs = [self.output / f"{self.sequence}-engine.log", self.output / "worker-stderr.log"]
        if any(p.exists() and p.stat().st_size > MAX_LOG_BYTES for p in logs):
            raise InvalidReference("Reference diagnostic limit exceeded")

    def _request(self, request: dict) -> dict:
        self.sequence += 1
        request["sequence"] = self.sequence
        self.child.stdin.write((json.dumps(request) + "\n").encode())
        self.child.stdin.flush()
        deadline = time.monotonic() + CALL_SECONDS
        while b"\n" not in self.pending:
            if time.monotonic() >= deadline:
                raise InvalidReference("Reference conversion timed out; owned worker retired")
            self._check_log_bounds()
            if select.select([self.child.stdout], [], [], .1)[0]:
                chunk = os.read(self.child.stdout.fileno(), 65536)
                if not chunk:
                    raise InvalidReference("Reference worker ended without a complete result")
                self.pending += chunk
                if len(self.pending) > 65536:
                    raise InvalidReference("Reference protocol limit exceeded")
        line, self.pending = self.pending.split(b"\n", 1)
        response = json.loads(line)
        if response.get("sequence") != self.sequence:
            raise InvalidReference("Reference response identity mismatch")
        self._check_log_bounds()
        return response

    def shape(self, express_id: int) -> dict:
        """Copy owned shape arrays only after its complete diagnostics pass."""
        try:
            response = self._request({"id": express_id})
            raw = (self.output / f"{self.sequence}-engine.log").read_bytes()
            log = diagnostics(raw.decode("utf-8", errors="replace"))
            row = {"id": express_id, "sequence": self.sequence, "diagnostics": log,
                   "engineLogSHA256": hashlib.sha256(raw).hexdigest(),
                   "conversionStatus": response["status"]}
            row["response"] = response
            self.records.append(row)
            if not log["referenceUsable"]:
                raise InvalidReference(f"#{express_id}: invalid or unresolved engine diagnostics; see sidecar")
            if response["status"] != "ok":
                raise ShapeUnavailable(response.get("errorType", "conversion-error"))
            path = self.output / f"{self.sequence}-mesh.json"
            data = path.read_bytes()
            row["meshSHA256"] = hashlib.sha256(data).hexdigest()
            return json.loads(data)
        except ShapeUnavailable:
            raise
        except BaseException as error:
            self.failure = repr(error)
            self.close()
            raise

    def close(self):
        """Reap only this session's process; never restore caller logger globals."""
        if self.closed:
            return
        self.closed = True
        try:
            self.child.stdin.close()
        except BrokenPipeError as error:
            self.failure = self.failure or repr(error)
        try:
            self.child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.child.terminate()
            try:
                self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()
        self.child.stdout.close()
        self.stderr.close()
        unchanged = self.fixture.is_file() and hashlib.sha256(self.fixture.read_bytes()).hexdigest() == self.fixture_hash
        if not unchanged:
            self.failure = "Fixture changed during reference conversion"
        if self.child.returncode != 0 and self.failure is None:
            self.failure = f"Reference worker exited {self.child.returncode}"
        final_logs = {}
        log_failure = False
        for path in sorted(self.output.glob("*.log")):
            if path.stat().st_size > MAX_LOG_BYTES:
                final_logs[path.name] = {"referenceUsable": False, "reason": "Diagnostic limit exceeded"}
            else:
                final_logs[path.name] = diagnostics(path.read_text(errors="replace"))
            log_failure |= not final_logs[path.name]["referenceUsable"]
        files = {}
        for path in sorted(self.output.iterdir()):
            if path.is_file():
                digest = hashlib.sha256()
                with path.open("rb") as retained:
                    for chunk in iter(lambda: retained.read(1024 * 1024), b""):
                        digest.update(chunk)
                files[path.name] = digest.hexdigest()
        required_logs = {"1-engine.log", "worker-stderr.log"} | {
            f"{row['sequence']}-engine.log" for row in self.records}
        for name in required_logs:
            if name not in files or name not in final_logs:
                final_logs[name] = {"referenceUsable": False, "reason": "Retained log missing"}
                log_failure = True
        for row in self.records:
            name = f"{row['sequence']}-engine.log"
            row["initialEngineLogSHA256"] = row["engineLogSHA256"]
            row["engineLogSHA256"] = files.get(name)
            row["diagnostics"] = final_logs.get(name, {"referenceUsable": False, "reason": "Retained log missing"})
            log_failure |= name not in files or not row["diagnostics"]["referenceUsable"]
        if log_failure:
            self.failure = self.failure or "Invalid or unresolved final engine diagnostics"
        receipt = {"fixtureSHA256": self.fixture_hash, "settings": self.settings,
                   "engine": getattr(self, "engine", None), "calls": self.records,
                   "initializationResponse": getattr(self, "initialization_response", None),
                   "workerExit": self.child.returncode, "fileSHA256": files,
                   "failure": self.failure,
                   "fixtureUnchanged": unchanged,
                   "finalLogDiagnostics": final_logs,
                   "finalLogsValidated": not log_failure,
                   "limitation": "No terminal diagnostic is necessary, not sufficient, for reference validity."}
        (self.output / "receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n")
        if not unchanged:
            raise InvalidReference(self.failure)
        if self.child.returncode != 0:
            raise InvalidReference(self.failure)
        if log_failure:
            raise InvalidReference(self.failure)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
