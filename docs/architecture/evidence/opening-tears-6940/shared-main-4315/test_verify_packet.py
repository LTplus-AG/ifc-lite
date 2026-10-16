# SPDX-License-Identifier: MPL-2.0
"""Black-box packet integrity regressions for PR #7712; stdlib only.

Run: python3 -m unittest discover -s docs/architecture/evidence/opening-tears-6940/shared-main-4315 -p 'test_verify_packet.py' -v
"""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

VERIFIER = Path(__file__).with_name('verify-packet.py')


def record(name, data, **extra):
    return dict(path=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), **extra)


def encode(value):
    return json.dumps(value).encode()


def archive_bytes(members):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for name, data in members:
            member = tarfile.TarInfo(name)
            if data is None:
                member.type = tarfile.SYMTYPE
                member.linkname = 'payload.bin'
                archive.addfile(member)
            else:
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
    return stream.getvalue()


class PacketIntegrity(unittest.TestCase):
    def packet(self, directory, fault=None):
        """Create independently bound containers; adversaries rebind outer hashes."""
        payload = b'authentic geometry proof bytes'
        file_record = record('payload.bin', payload, storage='archive')
        rows = [file_record]
        members = [('payload.bin', payload)]
        if fault == 'duplicate execution record':
            rows.append(dict(file_record))
            members.append(('payload.bin', payload))
        elif fault == 'trailing slash execution alias':
            rows.append(record('payload.bin/', payload, storage='archive'))
            members.append(('payload.bin/', b'corrupt physical header'))
        elif fault == 'duplicate execution member':
            members.append(('payload.bin', b'shadowed unverified bytes'))
        elif fault == 'missing execution member':
            members = []
        elif fault == 'extra execution member':
            members.append(('extra.bin', b'extra'))
        elif fault == 'damaged payload':
            members = [('payload.bin', b'changed')]
        elif fault == 'symlink execution member':
            members = [('payload.bin', None)]
        elif fault == 'forged payload hash':
            rows[0]['sha256'] = '0' * 64
        elif fault == 'forged payload length':
            rows[0]['bytes'] += 1
        copy = b'published screenshot'
        rows.append(record('copy.png', copy, storage='copy'))
        (directory / 'copy.png').write_bytes(copy)
        evidence = archive_bytes(members)
        evidence_record = record('execution.tar', evidence, members=len([r for r in rows if r['storage'] == 'archive']))
        original = dict(archive=dict(evidence_record), files=rows)
        if fault == 'archive binding':
            original['archive']['sha256'] = '0' * 64
        original_bytes = encode(original)
        metadata_members = [('manifest.json', original_bytes), ('receipt.txt', b'receipt')]
        metadata_records = [record(name, data) for name, data in metadata_members]
        if fault == 'duplicate metadata record':
            metadata_records.append(dict(metadata_records[-1]))
            metadata_members.append(metadata_members[-1])
        elif fault == 'trailing slash metadata alias':
            metadata_records.append(record('receipt.txt/', b'receipt'))
            metadata_members.append(('receipt.txt/', b'corrupt physical header'))
        elif fault == 'duplicate metadata member':
            metadata_members.append(('receipt.txt', b'shadowed bytes'))
        elif fault == 'missing metadata member':
            metadata_members.pop()
        elif fault == 'extra metadata member':
            metadata_members.append(('extra.txt', b'extra'))
        elif fault == 'damaged metadata':
            metadata_members[-1] = ('receipt.txt', b'changed')
        elif fault == 'symlink metadata member':
            metadata_members[-1] = ('receipt.txt', None)
        metadata = archive_bytes(metadata_members)
        index = dict(archive=evidence_record,
                     auditMetadata=record('metadata.tar', metadata, members=metadata_records),
                     originalMemberManifest=dict(member='manifest.json', bytes=len(original_bytes),
                                                 sha256=hashlib.sha256(original_bytes).hexdigest()))
        if fault == 'forged original hash':
            index['originalMemberManifest']['sha256'] = '0' * 64
        (directory / 'execution.tar').write_bytes(evidence)
        (directory / 'metadata.tar').write_bytes(metadata)
        if fault == 'damaged outer archive':
            (directory / 'execution.tar').write_bytes(b'broken')
        elif fault == 'damaged outer metadata':
            (directory / 'metadata.tar').write_bytes(b'broken')
        elif fault == 'damaged copy':
            (directory / 'copy.png').write_bytes(b'changed')
        (directory / 'manifest.json').write_bytes(encode(index))

    def invoke(self, directory, optimized):
        return subprocess.run([sys.executable, *(['-O'] if optimized else []),
                               str(VERIFIER), str(directory)], capture_output=True, text=True)

    def test_complete_consistent_packet(self):
        for optimized in [False, True]:
            with self.subTest(optimized=optimized), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                self.packet(directory)
                result = self.invoke(directory, optimized)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), dict(allSelectedBytesVerified=True,
                                 archiveMembers=1, originalMetadataByteIdentical=True,
                                 geometryExecution=False))

    def test_corruption_and_ambiguity_fail_closed(self):
        faults = {
            'trailing slash execution alias': 'payload.bin/: byte length differs',
            'trailing slash metadata alias': 'auditMetadata/receipt.txt/: byte length differs',
            'duplicate execution record': 'duplicate path',
            'duplicate execution member': 'duplicate path',
            'duplicate metadata record': 'duplicate path',
            'duplicate metadata member': 'duplicate path',
            'missing execution member': 'member set differs',
            'extra execution member': 'member set differs',
            'missing metadata member': 'member set differs',
            'extra metadata member': 'member set differs',
            'damaged payload': 'payload.bin: byte length differs',
            'damaged metadata': 'auditMetadata/receipt.txt: SHA256 differs',
            'symlink execution member': 'not a regular file',
            'symlink metadata member': 'not a regular file',
            'forged payload hash': 'payload.bin: SHA256 differs',
            'forged payload length': 'payload.bin: byte length differs',
            'forged original hash': 'originalMemberManifest: SHA256 differs',
            'archive binding': 'original archive binding differs',
            'damaged outer archive': 'execution.tar: byte length differs',
            'damaged outer metadata': 'metadata.tar: byte length differs',
            'damaged copy': 'copy.png: byte length differs',
        }
        for optimized in [False, True]:
            for fault, error in faults.items():
                with self.subTest(optimized=optimized, fault=fault), tempfile.TemporaryDirectory() as tmp:
                    directory = Path(tmp)
                    self.packet(directory, fault)
                    result = self.invoke(directory, optimized)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn('allSelectedBytesVerified', result.stdout)
                    self.assertIn(error, result.stderr)


if __name__ == '__main__':
    unittest.main()
