# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# #6537 lossless archive and bounded-reader invariants; actual data, no source assertions.
from pathlib import Path
import base64,hashlib,json,importlib.util,lzma,tempfile,unittest,copy
P=Path(__file__).resolve().with_name('replay.py')
spec=importlib.util.spec_from_file_location('evidence_replay',P);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def sample():
 raw=b'{"actual":42}';h=hashlib.sha256(raw).hexdigest();records=[{'path':'hosted/proof.json','bytes':len(raw),'sha256':h}]
 return {'format':'sha256-addressed-lossless-records-v1','records':records,'payloads':{h:base64.b64encode(raw).decode()}},{'format':'sha256-addressed-lossless-records-v1','records':copy.deepcopy(records),'recordCount':1,'uniquePayloadCount':1,'originalBytes':len(raw)}
class RealDataInvariants(unittest.TestCase):
 def test_lossless_native_bytes(self):
  e,manifest=sample();self.assertEqual(m.checked_records(e,manifest)['hosted/proof.json'],b'{"actual":42}')
 def test_path_traversal_refused_before_any_extraction(self):
  e,manifest=sample();e['records'][0]['path']=manifest['records'][0]['path']='../outside';self.assertRaisesRegex(ValueError,'logical path',m.checked_records,e,manifest)
 def test_duplicate_logical_payload_refused(self):
  e,manifest=sample();e['records'].append(e['records'][0].copy());manifest['records'].append(manifest['records'][0].copy());manifest['recordCount']=2;manifest['originalBytes']*=2;self.assertRaisesRegex(ValueError,'duplicate logical',m.checked_records,e,manifest)
 def test_replaced_native_bytes_refuse_digest(self):
  e,manifest=sample();key=next(iter(e['payloads']));e['payloads'][key]=base64.b64encode(b'different bytes').decode();self.assertRaisesRegex(ValueError,'payload SHA',m.checked_records,e,manifest)
 def test_original_byte_count_refused(self):
  e,manifest=sample();e['records'][0]['bytes']=manifest['records'][0]['bytes']=999;self.assertRaisesRegex(ValueError,'original payload',m.checked_records,e,manifest)
 def test_duplicate_json_keys_refused(self):self.assertRaisesRegex(ValueError,'duplicate JSON',m.parse,b'{"x":1,"x":2}')
 def test_invalid_base64_refused(self):
  e,manifest=sample();e['payloads'][next(iter(e['payloads']))]='!';self.assertRaises(ValueError,m.checked_records,e,manifest)
 def test_real_xz_expansion_budget_refuses(self):
  raw=b'x'*100;packed=lzma.compress(raw);manifest={'archive':'raw-hosted-proof.json.xz','archiveBytes':len(packed),'archiveSHA256':m.sha(packed),'decodedJSONBytes':len(raw),'decodedJSONSHA256':m.sha(raw)}
  with tempfile.TemporaryDirectory() as directory:
   p=Path(directory);(p/manifest['archive']).write_bytes(packed);(p/'receipt-manifest.json').write_text(json.dumps(manifest));old=m.MAX_EXPANDED
   try:m.MAX_EXPANDED=16;self.assertRaisesRegex(ValueError,'expanded cap',m.read_archive,p)
   finally:m.MAX_EXPANDED=old
unittest.main()
