#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Acquire pinned public native tool wheels without pip/venv or system changes."""
import hashlib
import json
import platform
from pathlib import Path
import sys
from urllib.request import urlopen
from zipfile import ZipFile
from io import BytesIO

root = Path(sys.argv[1]).resolve()
if platform.system() != 'Linux' or platform.machine() != 'x86_64':
    raise SystemExit('Supply CMake/Ninja on PATH on platforms other than Linux x86_64')
root.mkdir(parents=True, exist_ok=True)
receipts = []
pins = [
    ('cmake', '3.31.6', 'cmake-3.31.6-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
     '1c8b05df0602365da91ee6a3336fe57525b137706c4ab5675498f662ae1dbcec'),
    ('ninja', '1.11.1.4', 'ninja-1.11.1.4-py3-none-manylinux_2_12_x86_64.manylinux2010_x86_64.whl',
     '096487995473320de7f65d622c3f1d16c3ad174797602218ca8c967f51ec38a0'),
]
for name, version, filename, expected in pins:
    with urlopen(f'https://pypi.org/pypi/{name}/{version}/json') as response:
        metadata = json.load(response)
    candidates = [item for item in metadata['urls'] if item['filename'] == filename]
    if len(candidates) != 1:
        raise SystemExit(f'Expected one {name} Linux x86_64 wheel')
    item = candidates[0]
    with urlopen(item['url']) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected or item['digests']['sha256'] != expected:
        raise SystemExit(f'{name} wheel SHA256 mismatch')
    with ZipFile(BytesIO(data)) as archive:
        for entry in archive.infolist():
            target = (root / entry.filename).resolve()
            if not target.is_relative_to(root):
                raise SystemExit('Wheel path escapes tools directory')
        archive.extractall(root)
    binaries = root / (f'ninja-{version}.data/scripts' if name == 'ninja' else 'cmake/data/bin')
    for executable in binaries.iterdir():
        if executable.is_file():
            executable.chmod(0o755)
    receipts.append({'name': name, 'version': version, 'url': item['url'], 'sha256': digest})
(root / 'acquisition.json').write_text(json.dumps(receipts, indent=2) + '\n')
