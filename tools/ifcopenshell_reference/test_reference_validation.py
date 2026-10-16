# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""#7723 actual engine-diagnostic admission and owned-process contracts."""
import hashlib
import gzip
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

try:
    from .reference_validation import diagnostics, ReferenceSession, InvalidReference
except ImportError:
    from reference_validation import diagnostics, ReferenceSession, InvalidReference

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EVIDENCE = HERE/'evidence/7723'


def engine_log(entity_id):
    return gzip.decompress((EVIDENCE/f'{entity_id}-engine.log.gz').read_bytes())


@contextmanager
def case_directory(label):
    """Retain real run artifacts when an owned diagnostic lane requests them."""
    evidence = os.environ.get('IFCLITE_ORACLE_TEST_EVIDENCE_DIR')
    if evidence:
        folder = Path(evidence)/label
        folder.mkdir(parents=True,exist_ok=False)
        yield str(folder)
    else:
        with tempfile.TemporaryDirectory() as folder:
            yield folder


class BooleanDiagnosticAdmission(unittest.TestCase):
    def test_7723_real_nonempty_uncut_fallback_cannot_be_reference(self):
        # Actual pinned 0.8.5 stdout: returned 20 vertices/36 triangles despite
        # six invalid-result retries and eventual terminal Boolean failure.
        raw = engine_log(396617)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),
                         'ac1c7949c2c61f33f870ed53b4a3c74404ebe7b519f17a43c61fa9c35627663a')
        result = diagnostics(raw.decode())
        self.assertFalse(result['referenceUsable'])
        self.assertEqual(len(result['terminalBooleanFailure']), 1)
        self.assertEqual(sum(r['message']=='Boolean operation yields invalid result'
                             for r in result['records']), 6)

    def test_7723_actual_base_without_boolean_failure_remains_usable(self):
        raw = engine_log(392821)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), '617df7195f6bee9a0ef189296c9449c1cd906752a8def8b2bd2f1a889a9b9038')
        self.assertTrue(diagnostics(raw.decode())['referenceUsable'])

    def test_7723_retry_failure_is_not_terminal_failure(self):
        rows = [{'level':'Notice','message':'Boolean operation yields invalid result'},
                {'level':'Notice','message':'Retrying boolean operation with higher fuzziness'},
                {'level':'Notice','message':'Boolean operation successful'}]
        self.assertTrue(diagnostics('\n'.join(map(json.dumps,rows)))['referenceUsable'])

    def test_7723_valid_disjoint_boolean_noop_remains_usable(self):
        row = {'level':'Notice','message':'No other operands remaining, using first operand'}
        self.assertTrue(diagnostics(json.dumps(row))['referenceUsable'])

    def test_7723_explicit_invalid_operand_fallback_is_rejected(self):
        row = {'level':'Warning','message':'Invalid operands. Using first operand'}
        self.assertFalse(diagnostics(json.dumps(row))['referenceUsable'])

    def test_7723_unknown_error_or_truncated_json_cannot_be_reference(self):
        self.assertFalse(diagnostics('{"level":"Error","message":"unknown engine failure"}')['referenceUsable'])
        self.assertFalse(diagnostics('{"level":"Notice","message":') ['referenceUsable'])

    def test_7723_plain_or_truncated_native_error_cannot_be_reference(self):
        self.assertFalse(diagnostics('Error: failed Boolean conversion')['referenceUsable'])
        self.assertFalse(diagnostics('No longer attempting boolean operation with higher fuzz')['referenceUsable'])
        self.assertTrue(diagnostics('Scanning file...\n\r#123\r#456\nDone scanning file   \nDone resolving references\n')['referenceUsable'])


class OwnedReferenceConversion(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import ifcopenshell
        except ImportError:
            raise unittest.SkipTest('Pinned IfcOpenShell required; install requirements.lock')
        if ifcopenshell.version != '0.8.5':
            raise unittest.SkipTest('Requires pinned IfcOpenShell 0.8.5')

    def test_7723_real_reporter_conversion_preserves_mesh_and_reaps_worker(self):
        fixture = ROOT/'rust/geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc'
        with case_directory('real-reporter') as tmp:
            session = ReferenceSession(fixture, {'use-world-coords':True}, Path(tmp)/'diagnostics')
            with session:
                mesh = session.shape(107)
                self.assertTrue(mesh['positions'])
                self.assertTrue(mesh['indices'])
                self.assertEqual(len(mesh['indices'])%3,0)
                # A second request uses the same parsed model/worker, with its own log.
                self.assertEqual(session.shape(107),mesh)
            self.assertEqual(session.child.returncode,0)
            receipt = json.loads((session.output/'receipt.json').read_bytes())
            self.assertEqual([r['id'] for r in receipt['calls']],[107,107])
            self.assertTrue(receipt['finalLogsValidated'])
            self.assertTrue(all(r['diagnostics']['referenceUsable'] for r in receipt['calls']))
            for row in receipt['calls']:
                self.assertEqual(row['engineLogSHA256'],hashlib.sha256(
                    (session.output/f"{row['sequence']}-engine.log").read_bytes()).hexdigest())
            self.assertTrue(all(hashlib.sha256((session.output/k).read_bytes()).hexdigest()==v
                                for k,v in receipt['fileSHA256'].items()))

    def test_7723_late_terminal_log_prevents_final_publication(self):
        fixture = ROOT/'rust/geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc'
        terminal = next(line for line in engine_log(396617).decode().splitlines()
                        if 'No longer attempting boolean operation with higher fuzziness' in line)
        with case_directory('late-terminal') as tmp:
            session = ReferenceSession(fixture, {'use-world-coords':True}, Path(tmp)/'diagnostics')
            with self.assertRaises(InvalidReference,msg='late terminal diagnostic must prevent publication'):
                with session:
                    self.assertTrue(session.shape(107)['indices'])
                    # Real-file late flush fault: inject the captured terminal
                    # event AFTER per-call admission, before session publication.
                    with (session.output/'2-engine.log').open('a') as stream:
                        stream.write('\n'+terminal+'\n')
            self.assertEqual(session.child.returncode,0)
            receipt = json.loads((session.output/'receipt.json').read_bytes())
            self.assertFalse(receipt['finalLogsValidated'])
            self.assertFalse(receipt['calls'][0]['diagnostics']['referenceUsable'])

    def test_7723_owned_outer_timeout_contains_and_reaps_worker(self):
        fixture = ROOT/'rust/geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc'
        # The outer owner controls a NEW process group. Its worker must stay
        # in that group, while normal cleanup still signals only the worker PID.
        code = '''import signal,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from reference_validation import ReferenceSession
def timeout(*_):raise TimeoutError("owned outer timeout")
signal.signal(signal.SIGTERM,timeout)
with ReferenceSession(Path(sys.argv[2]),{"use-world-coords":True},Path(sys.argv[3])/"diagnostics") as session:
 Path(sys.argv[3],"worker-pid").write_text(str(session.child.pid))
 while True:time.sleep(.1)
'''
        with case_directory('owned-outer-timeout') as tmp:
            with (Path(tmp)/'outer.log').open('wb') as log:
                outer = subprocess.Popen([sys.executable,'-B','-c',code,str(HERE),str(fixture),tmp],
                                         stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                try:
                    ready = Path(tmp)/'worker-pid'
                    deadline = time.monotonic()+20
                    while not ready.exists() and outer.poll() is None and time.monotonic()<deadline:
                        time.sleep(.02)
                    self.assertTrue(ready.exists(),'owned outer did not initialize real worker')
                    pid = int(ready.read_text())
                    self.assertEqual(os.getpgid(pid),outer.pid,'worker escaped owner process group')
                    os.killpg(outer.pid,signal.SIGTERM)
                    outer.wait(timeout=10)
                    self.assertFalse(Path(f'/proc/{pid}').exists(),'owned worker was not reaped')
                finally:
                    if outer.poll() is None:
                        os.killpg(outer.pid,signal.SIGKILL)
                    outer.wait()


def cli(script, *args, log_path=None):
    """Bound only the test's own process group, including inherited workers."""
    child = subprocess.Popen([sys.executable,'-B',str(script),*map(str,args)],
                             stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
    try:
        output = child.communicate(timeout=300)[0].decode(errors='replace')
    except BaseException:
        if child.poll() is None:
            os.killpg(child.pid,signal.SIGKILL)
        child.communicate()
        raise
    if log_path is not None:
        log_path.write_text(output)
    return child.returncode,output


def box_boolean_fixture(path, disjoint):
    """Author exact boxes in the existing millimetre/project/placement context."""
    import ifcopenshell
    model = ifcopenshell.open(str(ROOT/'rust/geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc'))
    def box(width, depth, height, x, z):
        point2 = model.create_entity('IfcCartesianPoint',Coordinates=(0.,0.))
        axes2 = model.create_entity('IfcAxis2Placement2D',Location=point2)
        profile = model.create_entity('IfcRectangleProfileDef',ProfileType='AREA',Position=axes2,XDim=width,YDim=depth)
        point3 = model.create_entity('IfcCartesianPoint',Coordinates=(x,0.,z))
        axes3 = model.create_entity('IfcAxis2Placement3D',Location=point3)
        direction = model.create_entity('IfcDirection',DirectionRatios=(0.,0.,1.))
        return model.create_entity('IfcExtrudedAreaSolid',SweptArea=profile,Position=axes3,ExtrudedDirection=direction,Depth=height)
    base = box(2000.,2000.,2000.,0.,0.)
    cutter = box(1000.,1000.,4000.,5000. if disjoint else 0.,-1000.)
    difference = model.create_entity('IfcBooleanResult',Operator='DIFFERENCE',FirstOperand=base,SecondOperand=cutter)
    model.by_id(102).Items = (difference,)
    model.write(str(path))


class ReferenceCliContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OwnedReferenceConversion.setUpClass()

    def test_7723_actual_boolean_and_disjoint_reference_cli(self):
        for disjoint,volume in [(False,6.),(True,8.)]:
            with self.subTest(disjoint=disjoint),case_directory('disjoint' if disjoint else 'boolean-cut') as tmp:
                folder = Path(tmp)
                fixture = folder/('disjoint.ifc' if disjoint else 'cut.ifc')
                box_boolean_fixture(fixture,disjoint)
                output = folder/'out'
                status,log = cli(HERE/'dump_reference.py',fixture,'--out-dir',output,log_path=folder/'dump-cli.log')
                self.assertEqual(status,0,log)
                doc = json.loads((output/(fixture.stem+'.reference.json')).read_bytes())
                row = next(r for r in doc['elements'] if r['express_id']==107)
                self.assertEqual(row['status'],'ok')
                self.assertTrue(row['closed'])
                self.assertAlmostEqual(row['volume'],volume,places=8)
                validation = json.loads((output/(fixture.stem+'.reference-validation.json')).read_bytes())
                self.assertEqual(validation['canonicalSHA256'],hashlib.sha256(
                    (output/(fixture.stem+'.reference.json')).read_bytes()).hexdigest())

    def test_7723_actual_derived396_fallback_cli_refuses_publication(self):
        import ifcopenshell
        fixture = ROOT/'tests/models/ara3d/S_Office_Integrated Design Archi.ifc'
        if not fixture.exists():
            self.skipTest('SOffice fixture absent; run pnpm fixtures')
        self.assertEqual(hashlib.sha256(fixture.read_bytes()).hexdigest(),
                         '38c4ecbbc67d0759dfcffb2c90664f5b5231e6c48fc54597c62975b41bb629db')
        source = ifcopenshell.open(str(fixture))
        subset = ifcopenshell.file(schema=source.schema)
        original = source.by_id(396617)
        # Reserve the root BEFORE recursive copies allocate dependency IDs.
        # add(root,_id=107) can collide with a recursively allocated #107.
        product = subset.create_entity(original.is_a(),id=107)
        for index,value in enumerate(original):
            product[index] = subset.add(value) if isinstance(value,ifcopenshell.entity_instance) else value
        for project in source.by_type('IfcProject'):
            subset.add(project)
        self.assertEqual(product.id(),107)
        self.assertEqual([p.id() for p in subset.by_type('IfcProduct')],[107])
        with case_directory('derived396') as tmp:
            folder = Path(tmp)
            derived = folder/'derived396.ifc'
            subset.write(str(derived))
            reparsed = ifcopenshell.open(str(derived))
            self.assertEqual(reparsed.by_id(107).is_a(),original.is_a())
            self.assertIsNotNone(reparsed.by_id(107).Representation)
            self.assertTrue(reparsed.by_id(107).Representation.Representations[0].Items)
            (folder/'derivation.json').write_text(json.dumps({
                'sourceFixtureSHA256':hashlib.sha256(fixture.read_bytes()).hexdigest(),
                'sourceProductId':396617,'sourceProductType':original.is_a(),
                'derivedFixtureSHA256':hashlib.sha256(derived.read_bytes()).hexdigest(),
                'derivedProductId':107,'meaning':'DERIVED copy of actual referenced Boolean/project/placement graph; not original model identity'},indent=2))
            with self.assertRaises(InvalidReference):
                with ReferenceSession(derived,{'use-world-coords':True},folder/'preflight-diagnostics') as session:
                    session.shape(107)
            preflight = json.loads((folder/'preflight-diagnostics/2-mesh.json').read_bytes())
            self.assertEqual((len(preflight['positions'])//3,len(preflight['indices'])//3),(20,36))
            output = folder/'canonical'
            status,log = cli(HERE/'dump_reference.py',derived,'--out-dir',output,log_path=folder/'dump-cli.log')
            self.assertEqual(status,2,log)
            self.assertFalse((output/'derived396.reference.json').exists())
            diagnostics_dir = output/'derived396.reference-diagnostics'
            raw = json.loads((diagnostics_dir/'2-mesh.json').read_bytes())
            self.assertEqual((len(raw['positions'])//3,len(raw['indices'])//3),(20,36))
            retained = json.loads((diagnostics_dir/'receipt.json').read_bytes())
            self.assertFalse(retained['finalLogsValidated'])
            self.assertEqual(len(retained['calls'][0]['diagnostics']['terminalBooleanFailure']),1)
            candidate = folder/'candidate.json'
            candidate.write_text(json.dumps(raw))
            status,log = cli(ROOT/'docs/architecture/evidence/issue-7292/compare_surface.py',
                             '--prepared-fixture',derived,'--candidate',candidate,'--output',folder/'surface',
                             log_path=folder/'surface-cli.log')
            self.assertEqual(status,2,log)
            receipt = json.loads((folder/'surface/receipt.json').read_bytes())
            self.assertFalse(receipt['passed'])
            self.assertEqual(receipt['planes'],[])
            self.assertEqual(receipt['reference_status'],'INVALID_OR_UNRESOLVED')


if __name__=='__main__':
    unittest.main()
