# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Offline v1/v2 equality-decision oracle using actual Parquet, not source text."""
import hashlib
import io
import math
import struct
import unittest
import pyarrow as pa
import pyarrow.parquet as pq
import wire as v1
import wire_arrow_v2 as v2


def tables():
    mesh = {'express_id': 42, 'ifc_type': 'IFCWALL', 'vertex_start': 0, 'vertex_count': 3,
            'index_start': 0, 'index_count': 3, 'color_r': .2, 'color_g': .3,
            'color_b': .4, 'color_a': 1., 'origin_x': 0., 'origin_y': 0., 'origin_z': 0.,
            'geometry_class': 0, 'geometry_item_id': 9, 'material_id': 4,
            'rot0': 1., 'source_extra': 'retained', 'bounds_extra': 1.}
    vertices = [dict(x=x, y=y, z=0., nx=0., ny=0., nz=1.) for x, y in [(0., 0.), (1., 0.), (0., 1.)]]
    ms = pa.Table.from_pylist([mesh])
    vs = pa.Table.from_pylist(vertices, schema=pa.schema([(k, pa.float32()) for k in vertices[0]]))
    ts = pa.Table.from_pylist([dict(i0=0, i1=1, i2=2)], schema=pa.schema([(k, pa.uint32()) for k in ('i0', 'i1', 'i2')]))
    return [ms, vs, ts]


def pack(ts):
    out = bytearray()
    for table in ts:
        sink = io.BytesIO(); pq.write_table(table, sink)
        data = sink.getvalue(); out.extend(struct.pack('<I', len(data))); out.extend(data)
    return bytes(out)


def changed(ts, group, key, value, row=0):
    ts = list(ts); rows = ts[group].to_pylist(); rows[row][key] = value
    ts[group] = pa.Table.from_pylist(rows, schema=ts[group].schema)
    return ts


def witness(fn, ts):
    return sorted(fn(pack(ts)), key=lambda row: (row['entity'], row['digest']))


class GeometryEquivalence(unittest.TestCase):
    def assertDecision(self, left, right, equal):
        for fn in (v1.geometry, v2.geometry):
            self.assertEqual(witness(fn, left) == witness(fn, right), equal, fn.__module__)

    def test_every_field_is_observed(self):
        base = tables()
        for group, table in enumerate(base):
            for field in table.schema:
                if field.name in ('vertex_start', 'index_start', 'vertex_count', 'index_count'):
                    continue
                value = table[field.name][0].as_py()
                replacement = value + '-changed' if isinstance(value, str) else (0 if group == 2 and value else value + 1)
                with self.subTest(group=group, field=field.name):
                    self.assertDecision(base, changed(base, group, field.name, replacement), False)

    def test_one_ulp_signed_zero_and_nonfinite(self):
        base = tables()
        next_f32 = struct.unpack('<f', struct.pack('<I', 0x3f800001))[0]
        self.assertDecision(base, changed(base, 1, 'x', next_f32, 1), False)
        self.assertDecision(base, changed(base, 1, 'z', -0.), False)
        self.assertDecision(base, changed(base, 0, 'origin_x', -0.), False)
        self.assertDecision(base, changed(base, 0, 'bounds_extra', math.nextafter(1., 2.)), False)
        for group, field in [(0, 'origin_x'), (1, 'x')]:
            for value in (float('nan'), float('inf'), float('-inf')):
                for fn in (v1.geometry, v2.geometry):
                    with self.subTest(group=group, value=value, fn=fn.__module__):
                        with self.assertRaises(ValueError):
                            fn(pack(changed(base, group, field, value)))

    def test_local_order_and_duplicate_occurrences(self):
        base = tables(); swapped = list(base)
        swapped[1] = base[1].take(pa.array([1, 0, 2]))
        self.assertDecision(base, swapped, False)
        self.assertDecision(base, changed(base, 2, 'i1', 2), False)
        double = list(base); double[0] = pa.concat_tables([base[0], base[0]])
        self.assertDecision(base, double, False)
        for fn in (v1.geometry, v2.geometry):
            rows = fn(pack(double)); self.assertEqual(len(rows), 2); self.assertEqual(rows[0], rows[1])
        two_triangles = changed(base, 0, 'index_count', 6)
        two_triangles[2] = pa.concat_tables([base[2], changed(base, 2, 'i1', 2)[2]])
        reordered = list(two_triangles); reordered[2] = two_triangles[2].take(pa.array([1, 0]))
        self.assertDecision(two_triangles, reordered, False)
        different = changed(base, 0, 'express_id', 99)
        a = list(base); b = list(base)
        a[0] = pa.concat_tables([base[0], different[0]])
        b[0] = pa.concat_tables([different[0], base[0]])
        self.assertDecision(a, b, True)

    def test_storage_offsets_normalize_but_coverage_remains(self):
        base = tables()
        other = changed(base, 0, 'express_id', 99)
        other = changed(other, 1, 'x', 2.)
        a = list(base); b = list(base)
        shifted_other = changed(other, 0, 'vertex_start', 3)
        shifted_other = changed(shifted_other, 0, 'index_start', 3)
        shifted_base = changed(base, 0, 'vertex_start', 3)
        shifted_base = changed(shifted_base, 0, 'index_start', 3)
        a[0] = pa.concat_tables([base[0], shifted_other[0]])
        b[0] = pa.concat_tables([other[0], shifted_base[0]])
        a[1] = pa.concat_tables([base[1], other[1]])
        b[1] = pa.concat_tables([other[1], base[1]])
        a[2] = b[2] = pa.concat_tables([base[2], other[2]])
        self.assertDecision(a, b, True)
        invalid = [changed(base, 0, 'index_count', 4), changed(base, 0, 'vertex_count', 2),
                   changed(base, 0, 'vertex_start', 1), changed(base, 2, 'i2', 3)]
        extra = list(base); extra[1] = pa.concat_tables([base[1], base[1].slice(0, 1)]); invalid.append(extra)
        extra = list(base); extra[2] = pa.concat_tables([base[2], base[2]]); invalid.append(extra)
        for ts in invalid:
            for fn in (v1.geometry, v2.geometry):
                with self.assertRaises(ValueError): fn(pack(ts))

    def test_chunk_slices_and_schema(self):
        base = tables(); sliced = []
        for table in base:
            padded = pa.concat_tables([table, table, table])
            selected = padded.slice(len(table), len(table))
            sliced.append(pa.concat_tables([selected.slice(0, 1), selected.slice(1)]))
        self.assertEqual(v2.geometry_tables(*base), v2.geometry_tables(*sliced))
        self.assertDecision(base, sliced, True)
        changed_schema = list(base)
        changed_schema[1] = base[1].cast(pa.schema([(f.name, f.type, False) for f in base[1].schema]))
        self.assertDecision(base, changed_schema, False)
        reordered = list(base); reordered[1] = base[1].select(list(reversed(base[1].column_names)))
        self.assertDecision(base, reordered, False)

    def test_slice_prefix_and_suffix_are_not_values(self):
        raw = pa.array([float('nan'), 1., -0., float('inf')], type=pa.float32())
        columns = [pa.chunked_array([raw.slice(1, 2)]),
                   pa.chunked_array([pa.array([1.], type=pa.float32()), pa.array([-0.], type=pa.float32())])]
        hashes = []
        for column in columns:
            h = hashlib.sha256(); v2.hash_column(h, 'position', column); hashes.append(h.digest())
        self.assertEqual(*hashes)

    def test_null_payloads_and_future_columns(self):
        base = tables()
        base[1] = base[1].append_column('optional', pa.array([None, -0., 1.], type=pa.float32()))
        base[1] = base[1].append_column('label', pa.array([None, '', 'hello']))
        self.assertDecision(base, changed(base, 1, 'optional', 0., 1), False)
        self.assertDecision(base, changed(base, 1, 'label', '', 0), False)
        # Null payload bits are not logical values and must not affect hashes.
        arrays = [pa.Array.from_buffers(pa.float32(), 3,
                  [pa.py_buffer(bytes([6])), pa.py_buffer(struct.pack('<fff', hidden, -0., 1.))])
                  for hidden in (3., 99.)]
        hashes = []
        for array in arrays:
            h = hashlib.sha256(); v2.hash_column(h, 'optional', pa.chunked_array([array])); hashes.append(h.digest())
        self.assertEqual(*hashes)
        bad = changed(base, 1, 'optional', float('nan'), 2)
        for fn in (v1.geometry, v2.geometry):
            with self.assertRaises(ValueError): fn(pack(bad))
        # Nullable slices with different physical chunks have equal logical hashes.
        column = pa.chunked_array([arrays[0].slice(0, 1), arrays[0].slice(1)])
        h = hashlib.sha256(); v2.hash_column(h, 'optional', column)
        self.assertEqual(h.digest(), hashes[0])


if __name__ == '__main__':
    unittest.main()
