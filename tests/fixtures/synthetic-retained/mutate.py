#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Real fixture edit/run/restore mutations of issue_7955_synthetic.

Run --run inside ONE fleet admission, never nest fleet here. --list is read-only.
These are input/sidecar fault injections, not Rust kernel source mutants.
Full cargo transcripts and a final JSON receipt go to the admitted worker log.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
import sys
import zlib

FIXTURES = Path(__file__).resolve().parent
ROOT = FIXTURES.parents[2]
CARGO = ['cargo', 'test', '--locked', '-p', 'ifc-lite-processing', '--test', 'issue_7955_synthetic']
TESTS = {
    'a': 'issue_7955_curved_band_controls_and_wall_opening',
    'b': 'issue_7955_mapped_occurrence_volumes_and_appearance',
    'instances': 'issue_7955_mapped_instances_preserve_occurrences_and_cuts',
    'c': 'issue_7955_internal_consistency_geometry_matches_external_semantic_faces',
    'd': 'issue_7955_image_sidecar_uvs_and_pixels',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def replace_once(source, old, new):
    if source.count(old) != 1 or old == new:
        raise ValueError(f'mutation selector must match exactly once: {old!r}')
    return source.replace(old, new, 1)


def entity_line(source, entity_id):
    matches = re.findall(rf'^#{entity_id}=.*;$', source, re.M)
    if len(matches) != 1:
        raise ValueError(f'entity #{entity_id}: expected one row')
    return matches[0]


def drop_entity(source, entity_id):
    return replace_once(source, entity_line(source, entity_id)+'\n', '')


def wrong_png(data):
    """Change a pixel while preserving dimensions, valid compression and CRCs."""
    chunks = []
    offset = 8
    while offset < len(data):
        size = struct.unpack('>I', data[offset:offset+4])[0]
        kind = data[offset+4:offset+8]
        payload = data[offset+8:offset+8+size]
        if kind == b'IDAT':
            raw = bytearray(zlib.decompress(payload))
            raw[1] ^= 255  # first pixel red channel, after filter byte
            payload = zlib.compress(bytes(raw))
        chunks.append(struct.pack('>I', len(payload))+kind+payload+
                      struct.pack('>I', zlib.crc32(kind+payload)&0xffffffff))
        offset += 12+size
    return data[:8]+b''.join(chunks)


def plans():
    oracle = json.loads((FIXTURES/'oracles.json').read_text())['cases']
    a, b, c, d = [oracle[n] for n in ['f-a-curved.ifc', 'f-b-mapped.ifc', 'f-c-extrusion.ifc', 'f-d-texture.ifc']]
    by_role = {p['role']:p for p in b['products']}
    records = []

    def add(name, file, test, marker, transform, binary=False):
        original = (FIXTURES/file).read_bytes()
        mutated = transform(original if binary else original.decode())
        if not binary:
            mutated = mutated.encode()
        if original == mutated:
            raise ValueError('no-op mutation: '+name)
        records.append({'name':name, 'file':file, 'test':TESTS[test] if test else None,
                        'expected_failure':marker, 'original':original, 'mutated':mutated})

    add('missing_wall_cut', 'f-a-curved.ifc', 'a', 'curved-layered-wall.*volume',
        lambda s: drop_entity(s, a['products'][0]['void_relation']))
    add('missing_mapped_cut', 'f-b-mapped.ifc', 'b', 'door-left.*volume',
        lambda s: drop_entity(s, by_role['door-left']['void_relation']))
    add('moved_equal_volume_cut', 'f-b-mapped.ifc', 'b', 'centroid axis',
        lambda s: replace_once(s, 'IFCCARTESIANPOINT((0.5,0.5))', 'IFCCARTESIANPOINT((1.5,0.5))'))
    add('missing_occurrence_style', 'f-b-mapped.ifc', 'b', 'occurrence red style',
        lambda s: drop_entity(s, by_role['red']['styled_item']))

    def change_palette(source, transform):
        old = entity_line(source, b['palette']['map'])
        values = b['palette']['indices']
        before, after = [','.join(map(str, v)) for v in [values, transform(values)]]
        new = replace_once(old, f',({before}));', f',({after}));')
        return replace_once(source, old, new)
    add('reversed_source_palette', 'f-b-mapped.ifc', 'b', 'palette colour bound to wrong source triangle', lambda s: change_palette(s, lambda v: list(reversed(v))))
    add('facewise_source_palette', 'f-b-mapped.ifc', 'b', 'palette colour bound to wrong source triangle',
        lambda s: change_palette(s, lambda v: v[:6]+v[:6]))
    add('half_swapped_source_palette', 'f-b-mapped.ifc', 'b', 'palette colour bound to wrong source triangle',
        lambda s: change_palette(s, lambda v: v[6:]+v[:6]))

    def recolour_plain(source):
        # Follow StyledItem -> SurfaceStyle -> Shading -> ColourRGB.
        line = entity_line(source, by_role['plain']['styled_item'])
        style = int(re.findall(r'#(\d+)', line.split('=', 1)[1])[1])
        for _ in range(2):
            line = entity_line(source, style)
            style = int(re.findall(r'#(\d+)', line.split('=', 1)[1])[0])
        line = entity_line(source, style)
        return replace_once(source, line, replace_once(line, ',0.5,0.5,0.5)', ',1.,0.,0.)'))
    add('grey_occurrence_recoloured', 'f-b-mapped.ifc', 'b', 'occurrence plain style', recolour_plain)

    def move_wall_door(source, destination):
        rows = re.findall(r'^#\d+=IFCCARTESIANPOINT\(\(10.5,0.\)\);$', source, re.M)
        if len(rows) != 4:
            raise ValueError('expected host and three control cutter origins')
        return replace_once(source, rows[0], replace_once(rows[0], '(10.5,0.)', destination))
    add('curved_door_radial_move', 'f-a-curved.ifc', 'a', 'curved door cutter bounds',
        lambda s: move_wall_door(s, '(11.,0.)'))
    add('curved_door_tangential_move', 'f-a-curved.ifc', 'a', 'curved door cut planes',
        lambda s: move_wall_door(s, '(10.5,0.3)'))

    def wrong_scale(source):
        old = re.findall(r'^#\d+=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM\(.*;$', source, re.M)
        if len(old) != 1:
            raise ValueError('nonuniform operator selector')
        return replace_once(source, old[0], replace_once(old[0], ',0.5);', ',1.);'))
    add('doubled_nonuniform_z_scale', 'f-b-mapped.ifc', 'b', 'occurrence bounds', wrong_scale)
    add('missing_instance_occurrence', 'f-b-mapped.ifc', 'instances', 'product count/ids',
        lambda s: drop_entity(s, by_role['rotated']['id']))

    def taller_box(source):
        old = re.findall(r'^#\d+=IFCEXTRUDEDAREASOLID\(.*;$', source, re.M)
        if len(old) != 1:
            raise ValueError('extrusion selector')
        return replace_once(source, old[0], replace_once(old[0], ',3.);', ',3.25);'))
    add('changed_internal_box_height', 'f-c-extrusion.ifc', 'c', 'occurrence bounds', taller_box)
    add('changed_persistent_product_id', 'f-c-extrusion.ifc', 'c', 'stable GlobalId mismatch',
        lambda s: replace_once(s, "'"+c['GlobalId']+"'", "'"+c['GlobalId'][:-1]+('0' if c['GlobalId'][-1]!='0' else '1')+"'"))

    def ignored_uv_indices(source):
        old = entity_line(source, d['texture_map'])
        lists = lambda ts: '('+','.join('('+','.join(map(str,t))+')' for t in ts)+')'
        new = replace_once(old, ','+lists(d['texture_indices'])+');', ','+lists(d['triangles'])+');')
        return replace_once(source, old, new)
    add('ignored_texture_indices', 'f-d-texture.ifc', 'd', 'UV differs from source chart', ignored_uv_indices)
    add('wrong_image_reference', 'f-d-texture.ifc', 'd', 'texture source identity',
        lambda s: replace_once(s, "'checker.png'", "'wrong.png'"))
    add('changed_sidecar_pixel', 'checker.png', 'd', 'assertion `left == right` failed', wrong_png, binary=True)
    def flip_layer_sense(source):
        line = entity_line(source, a['material_usage'])
        return replace_once(source, line, replace_once(line, '.NEGATIVE.', '.POSITIVE.'))

    def swap_layer_thicknesses(source):
        first = entity_line(source, a['bands'][0]['layer_id'])
        third = entity_line(source, a['bands'][2]['layer_id'])
        source = replace_once(source, first, replace_once(first, ',0.1,', ',0.3,'))
        return replace_once(source, third, replace_once(third, ',0.3,', ',0.1,'))

    for name, transform in [
        ('gap_layer_direction_sense', flip_layer_sense),
        ('gap_deleted_material_association', lambda s: drop_entity(s, a['material_association'])),
        ('gap_swapped_layer_thicknesses', swap_layer_thicknesses),
    ]:
        add(name, 'f-a-curved.ifc', None, '', transform)
        records[-1]['expected_survivor'] = True
        records[-1]['reason'] = 'Exact tests assert host total and independent band controls, not curved material decomposition.'
    # Deliberate coverage-gap probes: they must be reported as survivors, not
    # silently counted among killed geometry faults. Run ALL five tests for each.
    def alter_json(source, change):
        value = json.loads(source)
        change(value)
        return json.dumps(value, indent=2)+'\n'

    def merge_groups(value):
        case = value['cases']['f-b-mapped.ifc']
        case['definition_groups'] = [[p['role'] for p in case['products']]]

    def invented_face_keys(value):
        for name in ['f-c-extrusion.ifc', 'f-c-brep.ifc']:
            for role, face in value['cases'][name]['face_roles'].items():
                face['key'] = 'invented-not-engine-identity/'+role

    for name, file, change in [
        ('gap_definition_group_policy', 'oracles.json', merge_groups),
        ('gap_engine_face_identity', 'oracles.json', invented_face_keys),
        ('gap_native_query_policy', 'native-volume-preregistration.json',
         lambda v: v['rule'].update(relative_tolerance=0.5)),
    ]:
        add(name, file, None, '', lambda source, change=change: alter_json(source, change))
        records[-1]['expected_survivor'] = True
        records[-1]['reason'] = 'This policy is documented but is not consumed by the current exact assertions.'
    return records


def run_test(name, timeout):
    command = CARGO + ([name] if name else []) + ['--', '--nocapture', '--test-threads=1']
    if name:
        command += ['--exact']
    print('COMMAND '+json.dumps(command), flush=True)
    proc = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, start_new_session=True)
    timed_out = False
    try:
        try:
            output, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                output, _ = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                output, _ = proc.communicate()
    except BaseException:
        # Stop only this runner's child group BEFORE restoring its source.
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        raise
    print(output, end='', flush=True)
    return {'command':command, 'exit':proc.returncode, 'timed_out':timed_out,
            'output_sha256':digest(output.encode())}, output


def passed(run, output, count):
    return run['exit']==0 and not run['timed_out'] and f'test result: ok. {count} passed; 0 failed; 0 ignored;' in output



def failure_checks(record, run, output):
    """Require the intended assertion in exactly one named Rust panic.

    Rust may put a numeric thread id between the quoted name and 'panicked'.
    Match the panic message itself, never a marker elsewhere in Cargo's output.
    Our assertion diagnostics occupy the first line after the panic location.
    """
    headers = list(re.finditer(
        r"^thread '([^'\n]+)'(?: \([0-9]+\))? panicked at [^\n]+:\n", output, re.M))
    named = len(headers) == 1 and headers[0][1] == record['test']
    message = output[headers[0].end():].partition('\n')[0] if named else ''
    summaries = re.findall(r'^test result: .*$', output, re.M)
    return {
        'exit_101': run['exit'] == 101,
        'completed': not run['timed_out'],
        'one_failed_test': len(summaries) == 1 and re.fullmatch(
            r'test result: FAILED\. 0 passed; 1 failed; 0 ignored; 0 measured; '
            r'[0-9]+ filtered out; finished in .+', summaries[0]) is not None,
        'named_panic': named,
        'intended_assertion': bool(record['expected_failure']) and named
            and re.search(record['expected_failure'], message) is not None,
    }


def classify(record, run, output):
    checks = failure_checks(record, run, output)
    status = 'killed' if all(checks.values()) else 'survived' if passed(
        run, output, 1 if record['test'] else 5) else 'unqualified_failure'
    return status, checks


def self_test():
    # Also invoked before --run, so the runner cannot silently omit its own tests.
    subprocess.run([sys.executable, str(FIXTURES/'test_mutation_matcher.py')], check=True)


def execute(records, timeout, receipt):
    control, output = run_test(None, timeout)
    receipt['baseline'] = control
    if not passed(control, output, 5):
        raise RuntimeError('baseline did not execute/pass all five tests')
    for record in records:
        path = FIXTURES/record['file']
        original = record['original']
        if path.read_bytes()!=original:
            raise RuntimeError('source changed since mutation plan')
        result = {k:v for k,v in record.items() if k not in ('original','mutated')}
        result.update(before_sha256=digest(original), mutant_sha256=digest(record['mutated']))
        receipt['mutations'].append(result)
        try:
            path.write_bytes(record['mutated'])
            run, output = run_test(record['test'], timeout)
            result['run'] = run
            result['status'], result['failure_checks'] = classify(record, run, output)
        finally:
            path.write_bytes(original)
            result['restored_sha256'] = digest(path.read_bytes())
        control, output = run_test(record['test'], timeout)
        result['restored_control'] = control
        result['restored_control_passed'] = passed(control, output, 1 if record['test'] else 5)
        if not result['restored_control_passed']:
            raise RuntimeError('restored control failed: '+record['name'])
    receipt['required_kills_passed'] = all(m['status']=='killed' and m['restored_control_passed']
        for m in receipt['mutations'] if not m.get('expected_survivor'))
    receipt['gap_probes_matched'] = all(m['status']=='survived' and m['restored_control_passed']
        for m in receipt['mutations'] if m.get('expected_survivor'))
    receipt['passed'] = receipt['required_kills_passed'] and receipt['gap_probes_matched']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--list', action='store_true')
    mode.add_argument('--run', action='store_true')
    mode.add_argument('--self-test', action='store_true', help='offline captured-panic matcher tests')
    parser.add_argument('--timeout', type=int, default=300, help='seconds per cargo invocation')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.run:
        self_test()
    records = plans()
    if args.list:
        print(json.dumps([{k:v for k,v in r.items() if k not in ('original','mutated')} for r in records], indent=2))
        return
    if git('status','--porcelain','--untracked-files=no'):
        raise SystemExit('refusing to mutate a dirty tracked checkout')
    lock_path = Path(git('rev-parse','--git-path','synthetic-7955-mutations.lock'))
    if not lock_path.is_absolute():
        lock_path = ROOT/lock_path
    with lock_path.open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt = {'head':git('rev-parse','HEAD'), 'scope':'fixture input/sidecar mutations, not kernel-source mutation coverage',
                   'runner_sha256':digest(Path(__file__).read_bytes()), 'mutations':[], 'passed':False}
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt('SIGTERM')))
        try:
            execute(records,args.timeout,receipt)
        finally:
            receipt['tracked_source_restored'] = not bool(git('status','--porcelain','--untracked-files=no'))
            if not receipt['tracked_source_restored']:
                receipt['passed'] = False
            print('MUTATION_RECEIPT '+json.dumps(receipt,sort_keys=True), flush=True)
        raise SystemExit(0 if receipt['passed'] else 1)


if __name__=='__main__':
    main()
