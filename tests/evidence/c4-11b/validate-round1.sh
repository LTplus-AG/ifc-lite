#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Run through ifc-fleet; no nested admission or automatic retries.
set -euo pipefail
# The completing layer's allocator witness also uses these two catalog models.
# Link only missing generated inputs; the host fixture cache is read-only here.
python3 - <<'PY'
from pathlib import Path
for name in ('AC20-FZK-Haus.ifc', 'duplex.ifc'):
    dest = Path('tests/models/ara3d') / name
    source = Path.home() / 'build-workers/ifc-lite/tests/models/ara3d' / name
    if not dest.exists() and not dest.is_symlink() and source.is_file():
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.symlink_to(source.resolve())
PY
export IFC_LITE_REQUIRE_FIXTURES=1
set -x
node scripts/check-module-size.mjs
node scripts/check-rust-api-surface.mjs
node scripts/check-agents-md-size.mjs
if [[ ${1:-all} != static ]]; then
cargo test -p ifc-lite-wasm --lib c4_10a -- --nocapture
cargo test -p ifc-lite-wasm --lib c4_11 -- --nocapture
cargo test -p ifc-lite-processing --test module_size_ratchet --test function_length_ratchet --test positional_read_ratchet
fi
for patch in tests/evidence/c4-11b/behaviour.oracle.patch tests/evidence/c4-11b-prepass/{behaviour,meta}.oracle.patch; do
  if [[ -f "$patch" ]]; then git apply --reverse --check "$patch"; fi
done
python3 - <<'PY'
from pathlib import Path
import hashlib
import subprocess
lines = Path('.github/workflows/test.yml').read_text().splitlines()
name = next(i for i, line in enumerate(lines) if 'name: Prove the changed tests observe the production change' in line)
start = next(i for i in range(name + 1, len(lines)) if lines[i].strip() == 'run: |')
indent = len(lines[start]) - len(lines[start].lstrip()) + 2
body = []
for line in lines[start + 1:]:
    if line.strip() and len(line) - len(line.lstrip()) < indent:
        break
    body.append(line[indent:])
script = '\n'.join(body) + '\n'
subprocess.run(['bash', '-n'], input=script.encode(), check=True)
print('C4_ORACLE_BASH_N_OK', len(body), 'lines', hashlib.sha256(script.encode()).hexdigest())
PY
