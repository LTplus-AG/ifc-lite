# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Private HTTP witness contract: real Parquet encoding, exact field mutations."""
import copy,io,struct,unittest
import pyarrow as pa
import pyarrow.parquet as pq
from wire import geometry,digest,sections

def pack(tables):
    result=b''
    for rows in tables:
        sink=io.BytesIO();pq.write_table(pa.Table.from_pylist(rows),sink)
        data=sink.getvalue();result+=struct.pack('<I',len(data))+data
    return result

class WireContract(unittest.TestCase):
    def setUp(self):
        self.mesh={'express_id':42,'ifc_type':'IFCWALL','vertex_start':0,'vertex_count':3,'index_start':0,'index_count':3,
                   'color_r':.2,'color_g':.3,'color_b':.4,'color_a':1.,'origin_x':0.,'origin_y':0.,'origin_z':0.,
                   'geometry_class':0,'geometry_item_id':9,'material_id':4}
        self.vertices=[dict(x=x,y=y,z=0.,nx=0.,ny=0.,nz=1.) for x,y in [(0.,0.),(1.,0.),(0.,1.)]]
        self.tris=[dict(i0=0,i1=1,i2=2)]
    def test_each_payload_group_and_duplicate_occurrences_are_observed(self):
        tables=[[self.mesh],self.vertices,self.tris];base=geometry(pack(tables))
        for group,key in [(0,'color_r'),(0,'geometry_item_id'),(0,'origin_x'),(1,'nx'),(1,'x'),(2,'i1')]:
            changed=copy.deepcopy(tables);changed[group][0][key]+=1
            self.assertNotEqual(base,geometry(pack(changed)),(group,key))
        doubled=geometry(pack([[self.mesh,self.mesh],self.vertices,self.tris]))
        self.assertEqual(len(doubled),2);self.assertEqual(doubled[0],doubled[1])
    def test_signed_zero_and_finite_exactness(self):
        self.assertNotEqual(digest(-0.),digest(0.))
        with self.assertRaises(ValueError):digest(float('nan'))
    def test_bad_frame_and_bad_geometry_span_fail(self):
        with self.assertRaises(ValueError):sections(b'\xff\xff\xff\xff',1)
        self.mesh['index_count']=4
        with self.assertRaises(ValueError):geometry(pack([[self.mesh],self.vertices,self.tris]))

if __name__=='__main__':unittest.main()
