# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Private APFS COW retention for explicitly released generated HTTP evidence.
No fixture/cache-input selection, hardlinks, or unique-content deletion. Planning
is read-only; applying verifies every replacement before atomic publication.
Run only outside timing windows. Independent inode is required before/after.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat
import time
import uuid

BLOCK = 2 * 1024 * 1024


def signature(path):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        raise ValueError(f'Expected independently owned regular file: {path}')
    return {'dev': s.st_dev, 'inode': s.st_ino, 'size': s.st_size,
            'mtimeNs': s.st_mtime_ns, 'mode': stat.S_IMODE(s.st_mode)}


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while block := stream.read(BLOCK): h.update(block)
    return h.hexdigest()


def same_bytes(a, b):
    with a.open('rb') as aa, b.open('rb') as bb:
        while True:
            x = aa.read(BLOCK); y = bb.read(BLOCK)
            if x != y: return False
            if not x: return True


def safe_path(root, relative):
    p = root / relative
    if p.resolve() != p.absolute() or not p.is_relative_to(root):
        raise ValueError(f'Path escapes root or traverses symlink: {p}')
    return p


def selected(path):
    return path.name in ('semantic.json', 'semantic-v2.json', 'data-model.bin') or (path.name.startswith('batch-') and path.suffix == '.bin')


def write_new(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())


def plan(root, released, output):
    sizes = {}; inventory = []
    for relative in released:
        directory = safe_path(root, relative)
        if not directory.is_dir(): raise ValueError(directory)
        for parent, dirs, files in os.walk(directory, followlinks=False):
            dirs[:] = [name for name in dirs if name != 'cache' and not (Path(parent) / name).is_symlink()]
            for name in files:
                p = Path(parent) / name
                if not selected(p): continue
                sig = signature(p); rel = str(p.relative_to(root))
                if any(row['path'] == rel for row in inventory): raise ValueError('Overlapping release scopes')
                row = {'path': rel, 'before': sig}; inventory.append(row)
                sizes.setdefault(sig['size'], []).append(row)
    groups = []
    for length, rows in sizes.items():
        if not length or len(rows) < 2: continue
        hashes = {}
        for row in rows:
            p = safe_path(root, row['path']); digest = sha(p)
            if signature(p) != row['before']: raise ValueError(f'File changed during planning: {p}')
            row['sha256'] = digest; hashes.setdefault(digest, []).append(row)
        for digest, matches in hashes.items():
            if len(matches) > 1:
                groups.append({'sha256': digest, 'bytesEach': length, 'files': matches})
    available = os.statvfs(root).f_bavail * os.statvfs(root).f_frsize
    result = {'protocol': 'apfs-evidence-retention-v1', 'createdUnix': time.time(), 'root': str(root),
              'releasedScopes': released, 'selection': 'semantic.json / semantic-v2.json / data-model.bin / batch-*.bin; cache directories excluded',
              'filesInventoried': len(inventory), 'logicalBytes': sum(row['before']['size'] for row in inventory),
              'availableBytesBefore': available, 'duplicateGroups': groups,
              'estimatedDuplicateLogicalBytes': sum(g['bytesEach'] * (len(g['files']) - 1) for g in groups),
              'limit': 'Potential shared extent bytes, not promised physical free space; APFS snapshots and existing clones can retain extents.'}
    write_new(output, result)
    print(json.dumps({k: v for k, v in result.items() if k != 'duplicateGroups'}, indent=2))


def clone(source, target):
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    fn = libc.clonefile; fn.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int); fn.restype = ctypes.c_int
    if fn(os.fsencode(source), os.fsencode(target), 0) != 0:
        code = ctypes.get_errno(); raise OSError(code, os.strerror(code), str(target))


def xattrs(path):
    # Apple's system Python omits os.listxattr; use the native macOS API.
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    libc.listxattr.argtypes = (ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int)
    libc.listxattr.restype = ctypes.c_ssize_t
    libc.getxattr.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int)
    libc.getxattr.restype = ctypes.c_ssize_t
    encoded = os.fsencode(path); size = libc.listxattr(encoded, None, 0, 0)
    if size < 0: raise OSError(ctypes.get_errno(), 'listxattr failed')
    names = ctypes.create_string_buffer(size)
    actual = libc.listxattr(encoded, names, size, 0)
    if actual < 0: raise OSError(ctypes.get_errno(), 'listxattr failed')
    result = {}
    for key in names.raw[:actual].split(b'\0'):
        if not key: continue
        length = libc.getxattr(encoded, key, None, 0, 0, 0)
        if length < 0: raise OSError(ctypes.get_errno(), 'getxattr failed')
        data = ctypes.create_string_buffer(length)
        actual = libc.getxattr(encoded, key, data, length, 0, 0)
        if actual < 0: raise OSError(ctypes.get_errno(), 'getxattr failed')
        result[key] = data.raw[:actual]
    return result


def set_xattrs(path, attrs):
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    libc.removexattr.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int)
    libc.setxattr.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int)
    encoded = os.fsencode(path)
    for key in xattrs(path):
        if key not in attrs and libc.removexattr(encoded, key, 0) != 0:
            raise OSError(ctypes.get_errno(), 'removexattr failed')
    for key, value in attrs.items():
        if libc.setxattr(encoded, key, value, len(value), 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'setxattr failed')
    if xattrs(path) != attrs: raise ValueError('Extended attribute preservation failed')


def apply(plan_path, output):
    manifest = json.loads(plan_path.read_text()); root = Path(manifest['root'])
    if output.exists(): raise FileExistsError(output)
    # Fail before any mutation if a released file changed after the dry run.
    for group in manifest['duplicateGroups']:
        for row in group['files']:
            if signature(safe_path(root, row['path'])) != row['before']:
                raise ValueError(f"File changed since plan: {row['path']}")
    log = output.open('x')
    def record(item):
        log.write(json.dumps(item) + '\n'); log.flush(); os.fsync(log.fileno())
    record({'type': 'start', 'plan': str(plan_path), 'planSha256': sha(plan_path), 'time': time.time()})
    try:
        for group in manifest['duplicateGroups']:
            source_row = group['files'][0]; source = safe_path(root, source_row['path'])
            if sha(source) != group['sha256']: raise ValueError('Canonical content changed')
            for row in group['files'][1:]:
                target = safe_path(root, row['path']); before = signature(target)
                if before != row['before'] or signature(source) != source_row['before']:
                    raise ValueError('File changed before replacement')
                if before['inode'] == source_row['before']['inode']: raise ValueError('Hardlink not allowed')
                temporary = target.with_name(target.name + '.cow-' + uuid.uuid4().hex)
                old_stat = target.stat()
                attrs = xattrs(target)
                clone(source, temporary)
                try:
                    if not same_bytes(temporary, target): raise ValueError('Exact byte comparison failed')
                    if sha(temporary) != group['sha256']: raise ValueError('Clone hash mismatch')
                    cloned = signature(temporary)
                    if cloned['inode'] in (before['inode'], source_row['before']['inode']): raise ValueError('Clone inode not independent')
                    set_xattrs(temporary, attrs)
                    os.chmod(temporary, before['mode'])
                    os.utime(temporary, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
                    if signature(target) != before or signature(source) != source_row['before']:
                        raise ValueError('File changed during replacement validation')
                    record({'type': 'verifiedBeforeReplace', 'source': source_row['path'], 'target': row['path'],
                            'sha256': group['sha256'], 'before': before, 'cloneInode': cloned['inode'], 'exactByteComparison': True})
                    os.replace(temporary, target)
                    after = signature(target)
                    if after['inode'] != cloned['inode'] or sha(target) != group['sha256']:
                        raise ValueError('Published clone verification failed')
                    record({'type': 'replaced', 'target': row['path'], 'after': after,
                            'sourceInode': source_row['before']['inode'], 'sha256': group['sha256'], 'bytes': group['bytesEach']})
                finally:
                    if temporary.exists(): temporary.unlink()  # only our unpublished clone
        free = os.statvfs(root).f_bavail * os.statvfs(root).f_frsize
        record({'type': 'complete', 'availableBytesAfter': free, 'time': time.time()})
    except Exception as error:
        record({'type': 'failed', 'error': repr(error), 'time': time.time()}); raise
    finally:
        log.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('plan'); p.add_argument('--root', type=Path, required=True); p.add_argument('--released', nargs='+', required=True); p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('apply'); p.add_argument('--plan', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'plan': plan(args.root.absolute(), args.released, args.output)
    else: apply(args.plan, args.output)
