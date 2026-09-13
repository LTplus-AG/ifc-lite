# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Offline CC BY 4.0 CRAS acquisition (#4381): one streaming pass over the
# COMPLETE verified archive, never unpacked to disk. Writes the archive's
# point count, bounds, label histogram and a 0.25 m occupancy histogram so a
# spatially bounded subset can be chosen from measured coverage instead of
# file order. Requires numpy + pandas.
# Usage: python cras-archive-histogram.py ARCHIVE.zip OUTPUT_DIRECTORY
import sys, zipfile, hashlib, json, pathlib, time
import numpy as np, pandas as pd
archive = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
CELL = 0.25
z = zipfile.ZipFile(archive); member = z.infolist()[0]
t0 = time.time(); rows = 0; lo = np.full(3, np.inf); hi = -lo; labels = {}; cells = {}
declared = None
with z.open(member) as f:
    header = f.readline(); declared = int(f.readline())
    for chunk in pd.read_csv(f, sep='\t', header=None, usecols=[0, 1, 2, 7], dtype=np.float64, chunksize=4_000_000, engine='c'):
        a = chunk.to_numpy()
        rows += len(a)
        lo = np.minimum(lo, a[:, :3].min(axis=0)); hi = np.maximum(hi, a[:, :3].max(axis=0))
        u, c = np.unique(a[:, 3], return_counts=True)
        for v, k in zip(u, c): labels[str(int(v))] = labels.get(str(int(v)), 0) + int(k)
        keys = np.floor(a[:, :3] / CELL).astype(np.int64)
        packed = (keys[:, 0] + 4096) * 8192 * 8192 + (keys[:, 1] + 4096) * 8192 + (keys[:, 2] + 4096)
        u, c = np.unique(packed, return_counts=True)
        for v, k in zip(u.tolist(), c.tolist()): cells[v] = cells.get(v, 0) + k
        if rows % 40_000_000 < 4_000_000: print(f'rows {rows:,} of {declared:,} in {time.time() - t0:.0f}s', flush=True)
def unpack(v):
    return [v // (8192 * 8192) - 4096, (v // 8192) % 8192 - 4096, v % 8192 - 4096]
occupied = sorted(cells.items())
np.save(out / 'cras-archive-cells.npy', np.array([[*unpack(v), k] for v, k in occupied], dtype=np.int64))
report = {
    'archive': {'name': archive.name, 'bytes': archive.stat().st_size, 'member': member.filename, 'member_bytes': member.file_size,
                'md5': hashlib.md5(archive.read_bytes()).hexdigest()},
    'header': header.decode().strip(), 'declared_points': declared, 'complete_rows': rows,
    'source_bounds_metres': [lo.tolist(), hi.tolist()], 'labels': labels,
    'occupancy': {'cell_metres': CELL, 'occupied_cells': len(occupied), 'file': 'cras-archive-cells.npy',
                  'columns': ['ix', 'iy', 'iz', 'count'], 'note': 'cell index = floor(coordinate / cell_metres)'},
    'seconds': round(time.time() - t0, 1),
    'registration': None,
}
(out / 'cras-archive-histogram.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'labels'}, indent=2), flush=True)
