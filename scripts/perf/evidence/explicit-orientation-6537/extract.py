#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Data-only extraction; never invokes Cargo, browsers or model processing."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if len(sys.argv) != 2:
        raise ValueError("usage: extract.py NEW_DESTINATION")
    source = Path(__file__).resolve().parent
    index = json.loads((source / "artifact-index.json").read_text())
    archive = (source / "correctness.tar.gz").read_bytes()
    manifest_bytes = (source / "member-manifest.json").read_bytes()
    if sha(archive) != index["sha256"] or sha(manifest_bytes) != index["memberManifestSHA256"]:
        raise ValueError("container/manifest identity differs")
    manifest = json.loads(manifest_bytes)
    expected = {row["path"]: row for row in manifest["members"]}
    if len(expected) != index["members"] or len(expected) != len(manifest["members"]):
        raise ValueError("manifest member census differs")
    verified = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for item in tar:
            path = PurePosixPath(item.name)
            if (not item.isfile() or path.is_absolute() or ".." in path.parts
                    or str(path) != item.name or item.name not in expected or item.name in verified):
                raise ValueError("unsafe/duplicate/unknown archive member")
            pin = expected[item.name]
            if item.size != pin["bytes"]:
                raise ValueError("member length differs")
            data = tar.extractfile(item).read()
            if sha(data) != pin["sha256"]:
                raise ValueError("member hash differs")
            verified[item.name] = data
    if set(verified) != set(expected):
        raise ValueError("archive member census differs")
    destination = Path(sys.argv[1]).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    for name, data in verified.items():
        target = destination.joinpath(*PurePosixPath(name).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    print(json.dumps({"status": "verified-data-only-extraction", "members": len(verified)}))


if __name__ == "__main__":
    main()
