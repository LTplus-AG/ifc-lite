# SPDX-License-Identifier: MPL-2.0
"""Linux atomic directory publication, including refusal of an empty destination.

Node's rename replaces empty directories. Never emulate NOREPLACE with a
check followed by rename: another publisher can win between those operations.
Unsupported hosts/filesystems fail closed; no fallback removes a destination.
"""
import ctypes
import os
import sys


def publish(source, destination):
    if sys.platform != "linux":
        raise RuntimeError("retained packaging requires Linux renameat2(RENAME_NOREPLACE)")
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2  # Missing libc support is a refusal, not a fallback.
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), destination)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: retained-publish.py SOURCE DESTINATION")
    publish(sys.argv[1], sys.argv[2])
