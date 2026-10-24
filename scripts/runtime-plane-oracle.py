#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955: compiled plane decoder/fault controls and exact reverse-patch kills.

Native Unix protocol peers only; no SDK or numerical qualification. The generic
oracle planner cannot select plane_faults.rs's all(unix, not(wasm32)) cfg.
"""
import json
import pathlib
import re
import signal
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
PATCH = 'rust/geometry-runtime/tests/fixtures/plane-behaviour.oracle.patch'
SOURCES = (
    'rust/geometry/src/document/retained_plane.rs',
    'rust/geometry-runtime/src/worker_clip.rs',
)
PREFIX = 'document::retained_plane::tests::'
DECODER = (
    'unary_plane_contract_rejects_packet_identity_drift_before_sealing',
    'unary_plane_contract_rejects_cylinder_flag_domain_and_record_drift',
    'plane_certificate_truncated_payload_is_an_error_not_a_panic',
    'issue7955_affine_rectangle_version_is_distinct_from_historical_v2',
    'issue7955_mixed_v3_cylinders_cover_truncation_and_sixteen_record_ceiling',
)
FAULTS = (
    'native_plane_fault_packets_retire_only_captured_owner',
    'native_plane_synchronized_refusal_and_taint_have_distinct_lifetimes',
    'native_plane_mesh_refusal_queues_managed_unpublished_output_and_preserves_input',
    'native_plane_unknown_postclip_status_retires_owner_and_preserves_primary_error',
    'native_plane_missing_capability_is_unsent_and_preserves_input',
)
# These assertions directly exercise the three reversed guards. The runtime
# plane peer changes +0.0 to -0.0; alias can still fail another identity check.
# Owner retirement and replacement liveness remain separate GREEN assertions.
KILLS = {
    PREFIX + DECODER[0]: 'assertion failed: PlaneCertificate::decode(',
    FAULTS[0]: 'plane fault must reject malformed certificate: plane',
    FAULTS[4]: 'assertion failed: matches!',
}


def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def build(package, selection, target):
    try:
        result = run(['cargo', 'test', '--locked', '-p', package, *selection,
                      '--no-run', '--message-format=json'], capture_output=True,
                     text=True, timeout=1800)
    except subprocess.CalledProcessError as error:
        print(error.stdout + error.stderr, end='', flush=True)
        raise
    executables = set()
    for line in result.stdout.splitlines():
        event = json.loads(line)
        if (event.get('reason') == 'compiler-artifact'
                and event.get('profile', {}).get('test')
                and event.get('target', {}).get('name') == target
                and event.get('executable')):
            executables.add(event['executable'])
    if len(executables) != 1:
        raise RuntimeError(f'expected exactly one executable for {target}')
    return executables.pop()


def witness(binary, name, killed):
    result = subprocess.run([binary, '--exact', name, '--nocapture'], cwd=ROOT,
                            capture_output=True, text=True, timeout=60)
    output = result.stdout + result.stderr
    print(output, end='', flush=True)
    if output.splitlines().count('running 1 test') != 1:
        raise RuntimeError(f'missing test: {name}')
    if killed:
        # Bind the marker to this test's actual panic, not arbitrary output.
        panic = re.search(
            rf"^thread '{re.escape(name)}'(?: \(\d+\))? panicked at [^\n]+:\n([^\n]+)",
            output, re.MULTILINE)
        marker = panic.group(1) if panic else ''
        intended = (marker == KILLS[name] if name == FAULTS[0]
                    else marker.startswith(KILLS[name]))
        if (result.returncode != 101 or not intended
                or f'test {name} ... FAILED' not in output.splitlines()
                or not re.search(r'^test result: FAILED\. 0 passed; 1 failed; 0 ignored;',
                                 output, re.MULTILINE)):
            raise RuntimeError(f'not the intended semantic assertion: {name}')
    elif (result.returncode != 0
          or f'test {name} ... ok' not in output.splitlines()
          or not re.search(r'^test result: ok\. 1 passed; 0 failed; 0 ignored;',
                           output, re.MULTILINE)):
        raise RuntimeError(f'control did not pass: {name}')


def phase(label, mutated=False):
    print(f'PHASE {label}', flush=True)
    # Both compilations must succeed before executing any mutant witness.
    decoder = build('ifc-lite-geometry', ['--lib'], 'ifc_lite_geometry')
    faults = build('ifc-lite-geometry-runtime', ['--test', 'plane_faults'], 'plane_faults')
    for binary, names in ((decoder, [PREFIX + n for n in DECODER]), (faults, FAULTS)):
        for name in names:
            witness(binary, name, mutated and name in KILLS)


def interrupted(signum, _frame):
    raise SystemExit(f'interrupted by signal {signum}')


def main():
    if run(['git', 'status', '--porcelain'], capture_output=True, text=True).stdout:
        raise RuntimeError('requires a clean checkpoint')
    originals = {path: (ROOT / path).read_bytes() for path in SOURCES}
    run(['git', 'apply', '--reverse', '--check', PATCH])
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    phase('GREEN')
    try:
        run(['git', 'apply', '--reverse', PATCH])
        phase('INTENDED_SEMANTIC_RED', mutated=True)
    finally:
        # Restore exact source bytes even on build failure, timeout or signal.
        for path, original in originals.items():
            (ROOT / path).write_bytes(original)
        run(['git', 'diff', '--exit-code', 'HEAD', '--', *SOURCES])
        phase('RESTORED_GREEN')
    print('OBSERVED: runtime plane decoder and fault assertions; restored GREEN', flush=True)


if __name__ == '__main__':
    main()
