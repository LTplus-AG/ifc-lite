# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Offline CC BY 4.0 CRAS acquisition (#4381): one streaming pass over the
# COMPLETE verified archive writes spatially bounded, systematically decimated
# subsets as binary PLY (double XYZ in unchanged source metres, RGB8, original
# row index, source label). Nothing is unpacked to disk, no point is moved,
# no normal or registration is invented. Requires numpy + pandas.
# Usage: python cras-archive-subset.py ARCHIVE.zip BOXES.json OUTPUT_DIRECTORY
#   BOXES.json: {"name": {"min": [x,y,z], "max": [x,y,z], "stride": k}, ...}
import sys, zipfile, hashlib, json, pathlib, time, struct
import numpy as np, pandas as pd
archive = pathlib.Path(sys.argv[1]); boxes = json.loads(pathlib.Path(sys.argv[2]).read_text()); out = pathlib.Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
z = zipfile.ZipFile(archive); member = z.infolist()[0]
kept = {name: [] for name in boxes}; seen = {name: 0 for name in boxes}
t0 = time.time(); rows = 0
with z.open(member) as f:
    header = f.readline(); declared = int(f.readline())
    for chunk in pd.read_csv(f, sep='\t', header=None, dtype=np.float64, chunksize=4_000_000, engine='c'):
        a = chunk.to_numpy(); index = np.arange(rows, rows + len(a)); rows += len(a)
        for name, box in boxes.items():
            lo, hi = np.array(box['min']), np.array(box['max'])
            inside = np.all((a[:, :3] >= lo) & (a[:, :3] <= hi), axis=1)
            hits = np.flatnonzero(inside)
            if not len(hits): continue
            ordinal = seen[name] + np.arange(len(hits))
            pick = hits[ordinal % box['stride'] == 0]
            seen[name] += len(hits)
            kept[name].append(np.column_stack([a[pick][:, [0, 1, 2, 3, 4, 5, 7]], index[pick]]))
        if rows % 40_000_000 < 4_000_000: print(f'rows {rows:,} of {declared:,} in {time.time() - t0:.0f}s', flush=True)
report = {'archive': {'name': archive.name, 'bytes': archive.stat().st_size, 'member': member.filename, 'md5': hashlib.md5(archive.read_bytes()).hexdigest()},
          'complete_rows': rows, 'declared_points': declared, 'boxes': {}, 'seconds': None, 'registration': None, 'normals': False}
for name, box in boxes.items():
    a = np.concatenate(kept[name]) if kept[name] else np.zeros((0, 8))
    ply = out / f'{name}.ply'
    head = ('ply\nformat binary_little_endian 1.0\n'
            'comment CRAS CC BY 4.0 doi:10.5281/zenodo.7948116 Abreu et al.; unchanged source metres, systematic subset, unregistered, no normals\n'
            f'comment box min {box["min"]} max {box["max"]} stride {box["stride"]}\n'
            f'element vertex {len(a)}\nproperty double x\nproperty double y\nproperty double z\n'
            'property uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar label\nproperty uint source_index\nend_header\n')
    with ply.open('wb') as w:
        w.write(head.encode())
        packer = struct.Struct('<dddBBBBI')
        for row in a:
            w.write(packer.pack(row[0], row[1], row[2], int(row[3]), int(row[4]), int(row[5]), int(row[6]), int(row[7])))
    report['boxes'][name] = {'min': box['min'], 'max': box['max'], 'stride': box['stride'], 'points_inside': int(seen[name]), 'points_kept': int(len(a)),
                             'bounds_kept': [a[:, :3].min(0).tolist(), a[:, :3].max(0).tolist()] if len(a) else None,
                             'labels_kept': {str(int(k)): int(v) for k, v in zip(*np.unique(a[:, 6], return_counts=True))} if len(a) else {},
                             'ply': {'file': ply.name, 'bytes': ply.stat().st_size, 'sha256': hashlib.sha256(ply.read_bytes()).hexdigest()}}
report['seconds'] = round(time.time() - t0, 1)
(out / 'cras-archive-subset.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2), flush=True)
