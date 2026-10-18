#!/usr/bin/env bash
set -euo pipefail
cd /home/louistrue/.t3/worktrees/ifc-lite/t3-f778e361
sha256sum Cargo.lock rust/python/Cargo.lock > /tmp/ifclite-context-final-nativepy-locks-before.log
CARGO_TARGET_DIR=/tmp/ifclite-work-python-target /tmp/ifclite-smlib-venv/bin/maturin build --locked --profile dev --manifest-path rust/python/Cargo.toml --interpreter /tmp/ifclite-smlib-venv/bin/python --out /tmp/ifclite-context-final-nativepy-wheel > /tmp/ifclite-context-final-nativepy-build.log 2>&1
/tmp/ifclite-smlib-venv/bin/python -m pip install --force-reinstall --no-deps /tmp/ifclite-context-final-nativepy-wheel/*.whl > /tmp/ifclite-context-final-nativepy-install.log 2>&1
/tmp/ifclite-smlib-venv/bin/python -m pytest rust/python/tests -q -ra --junitxml=/tmp/ifclite-context-final-nativepy-results.xml > /tmp/ifclite-context-final-nativepy-tests.log 2>&1
sha256sum /tmp/ifclite-context-final-nativepy-wheel/*.whl > /tmp/ifclite-context-final-nativepy-artifact.log
sha256sum Cargo.lock rust/python/Cargo.lock > /tmp/ifclite-context-final-nativepy-locks-after.log
cmp /tmp/ifclite-context-final-nativepy-locks-before.log /tmp/ifclite-context-final-nativepy-locks-after.log
/tmp/ifclite-smlib-venv/bin/python - <<'PY' > /tmp/ifclite-context-final-nativepy-environment.log
import sys, platform, importlib.metadata
print(sys.version)
print(platform.platform())
for name in ('pytest', 'maturin', 'numpy'):
    print(name, importlib.metadata.version(name))
PY
