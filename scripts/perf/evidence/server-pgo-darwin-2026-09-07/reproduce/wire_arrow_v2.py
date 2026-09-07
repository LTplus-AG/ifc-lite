# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Offline HTTP witness v2; geometry equivalence is v1, encoding is different.
Never replaces the active wire.py. Metadata tables deliberately retain v1.
Equivalence applies to valid server wire (unsigned offsets/counts/indices).
Malformed signed-negative spans/indices additionally fail closed, unlike v1.
"""
import hashlib
import json
import struct
import sys
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import wire as v1


def frame(h, name, payload):
    name = name.encode('utf8')
    h.update(struct.pack('<Q', len(name))); h.update(name)
    h.update(struct.pack('<Q', len(payload))); h.update(payload)


def canonical(value):
    return json.dumps(v1.encode(value), sort_keys=True, separators=(',', ':')).encode()


def schema(table):
    return [(f.name, str(f.type), f.nullable) for f in table.schema]


def hash_column(h, name, column):
    """Logical values only: no chunk markers, offset prefixes, or null garbage."""
    dtype = column.type
    numeric = pa.types.is_integer(dtype) or pa.types.is_float32(dtype) or pa.types.is_float64(dtype)
    if not numeric or column.null_count:
        # Rare nullable/future columns retain exact v1 logical-value semantics.
        frame(h, name + ':values', canonical(column.to_pylist()))
        return
    frame(h, name + ':type', str(dtype).encode())
    frame(h, name + ':count', struct.pack('<Q', len(column)))
    width = dtype.bit_width // 8
    # A single framed payload, independent of physical chunk boundaries.
    label = (name + ':little-endian-values').encode()
    h.update(struct.pack('<Q', len(label))); h.update(label)
    h.update(struct.pack('<Q', len(column) * width))
    for chunk in column.chunks:
        if pa.types.is_floating(dtype) and len(chunk):
            if not pc.all(pc.is_finite(chunk)).as_py():
                raise ValueError('Nonfinite value: exact bit witness requires extension')
        buf = chunk.buffers()[1]
        if not len(chunk):
            continue
        logical = memoryview(buf)[chunk.offset * width:(chunk.offset + len(chunk)) * width]
        if sys.byteorder == 'little':
            h.update(logical)
        else:
            # Explicit byte order; never reinterpret floating values numerically.
            h.update(chunk.to_numpy(zero_copy_only=True).byteswap().tobytes())


def covered(intervals, length):
    end = 0
    for start, stop in sorted(intervals):
        if start > end:
            return False
        end = max(end, stop)
    return end == length


def geometry_tables(meshes, vertices, triangles):
    schemas = [schema(t) for t in (meshes, vertices, triangles)]
    out = []; usedv = []; usedt = []
    for original in meshes.to_pylist():
        mesh = dict(original)
        v = mesh.pop('vertex_start'); n = mesh['vertex_count']
        i = mesh.pop('index_start'); k = mesh['index_count']
        if min(v, n, i, k) < 0 or i % 3 or k % 3 or v + n > len(vertices) or (i + k) // 3 > len(triangles):
            raise ValueError('Mesh span invalid')
        vv = vertices.slice(v, n); tt = triangles.slice(i // 3, k // 3)
        for key in ('i0', 'i1', 'i2'):
            column = tt[key]
            if column.null_count:
                raise ValueError('Null triangle index')
            if len(column) and (pc.min(column).as_py() < 0 or pc.max(column).as_py() >= n):
                raise ValueError('Triangle index out of range')
        h = hashlib.sha256()
        frame(h, 'protocol', b'http-wire-geometry-v2')
        frame(h, 'schemas', canonical(schemas))
        frame(h, 'mesh', canonical(mesh))
        for label, table in (('vertices', vv), ('triangles', tt)):
            frame(h, label + ':rows', struct.pack('<Q', len(table)))
            for field, column in zip(table.schema, table.columns):
                hash_column(h, label + ':' + field.name, column)
        usedv.append((v, v + n)); usedt.append((i // 3, (i + k) // 3))
        out.append({'entity': mesh['express_id'], 'digest': h.hexdigest(), 'vertices': n, 'triangles': k // 3})
    if not covered(usedv, len(vertices)) or not covered(usedt, len(triangles)):
        raise ValueError('Unreferenced wire rows')
    return out


def geometry(data):
    parts, _ = v1.sections(memoryview(data), 3)
    return geometry_tables(*(pq.read_table(pa.BufferReader(part)) for part in parts))


def decode_run(path, expected_cache=False):
    """Same v1 event gates; writes a separate semantic-v2.json artifact."""
    output = path / 'semantic-v2.json'
    if output.exists():
        raise FileExistsError(output)
    events = [json.loads(line) for line in (path / 'events.jsonl').read_text().splitlines()]
    complete = [e for e in events if e['type'] == 'complete']
    if len(complete) != 1:
        raise ValueError('Expected one complete event')
    meshes = []
    for event in events:
        if event['type'] == 'batch':
            rows = geometry((path / event['file']).read_bytes())
            if len(rows) != event['mesh_count']:
                raise ValueError('Batch mesh count differs')
            meshes.extend(rows)
    stats = complete[0]['stats']
    expected = {'total_meshes': len(meshes), 'total_vertices': sum(m['vertices'] for m in meshes),
                'total_triangles': sum(m['triangles'] for m in meshes)}
    if any(stats[k] != value for k, value in expected.items()):
        raise ValueError('Complete geometry totals disagree with wire')
    if expected_cache is not None and stats['from_cache'] != expected_cache:
        raise ValueError('Unexpected cache disposition')
    diagnostics = {k: value for k, value in stats.items() if not k.endswith('_time_ms') and k not in ('point_cache_hits', 'point_cache_misses', 'from_cache')}
    result = {'protocol': 'http-wire-v2', 'geometry': sorted(meshes, key=lambda r: (r['entity'], r['digest'])),
              'metadataDigest': v1.digest(complete[0]['metadata']), 'diagnostics': diagnostics,
              'symbolicDigest': v1.digest(complete[0].get('symbolic_data')),
              'dataModel': v1.data_model((path / 'data-model.bin').read_bytes())}
    with output.open('x') as stream:
        stream.write(json.dumps(result, indent=2) + '\n')
    return result
