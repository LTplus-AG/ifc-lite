#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Chrome wrapper that counts user-space retired instructions of the whole browser tree (load-scoreboard `instructions`).

Playwright launches this file as the browser executable. It forks; the child waits until the parent has opened one
`instructions:u` counter per CPU PMU (hybrid Intel: cpu_core and cpu_atom; else the generic hardware event) on it with
`inherit` and `enable_on_exec`, then execs the real Chrome (LOAD_SCOREBOARD_INSTR_CHROME). Every process and thread
Chrome creates inherits the counters, including the browser process that later moves itself into its own systemd
scope (counters follow tasks, not cgroups). Kernel work is excluded (:u); nothing outside the Chrome tree is counted.

While Chrome runs, the parent writes running totals every 10 ms to LOAD_SCOREBOARD_INSTR_OUT as NDJSON lines
`{"t": epoch_ms, "c": {pmu: count}}`; the harness interpolates them at the input event and the interactive mark.
No root and no `perf` binary: needs Linux, kernel.perf_event_paranoid <= 2. When counting is unavailable the first
line is `{"unavailable": reason}` and Chrome still runs normally. The wrapper exits with Chrome's exit status.
"""
import ctypes, json, os, signal, struct, sys, threading, time

PERIOD_S = float(os.environ.get('LOAD_SCOREBOARD_INSTR_PERIOD_MS', '10')) / 1000
SYS_PERF_EVENT_OPEN = {'x86_64': 298, 'aarch64': 241}.get(os.uname().machine)
PMU_ROOT = os.environ.get('LOAD_SCOREBOARD_INSTR_PMU_ROOT', '/sys/bus/event_source/devices')  # override for tests


class Attr(ctypes.Structure):
    _fields_ = [('type', ctypes.c_uint32), ('size', ctypes.c_uint32), ('config', ctypes.c_uint64), ('sample', ctypes.c_uint64),
                ('sample_type', ctypes.c_uint64), ('read_format', ctypes.c_uint64), ('flags', ctypes.c_uint64),
                ('wakeup', ctypes.c_uint32), ('bp_type', ctypes.c_uint32), ('config1', ctypes.c_uint64), ('config2', ctypes.c_uint64),
                ('pad', ctypes.c_uint64 * 8)]


DISABLED, INHERIT, EXCLUDE_KERNEL, EXCLUDE_HV, ENABLE_ON_EXEC = 1 << 0, 1 << 1, 1 << 5, 1 << 6, 1 << 12


def pmus():
    """([(name, type, config)], error) for instructions on EVERY core-type PMU the host has.

    Hybrid Intel exposes cpu_core and cpu_atom; a non-hybrid host exposes `cpu` (generic hardware event). A core PMU
    that exists but whose type or `instructions` event cannot be read or parsed makes the whole count unavailable: a
    P-core-only count must never pass as complete (review #10138).
    """
    try:
        names = sorted(os.listdir(PMU_ROOT))
    except OSError as err:
        return [], f'cannot list {PMU_ROOT}: {err}'
    hybrid = [n for n in names if n in ('cpu_core', 'cpu_atom')]
    if not hybrid:
        return ([('cpu', 0, 1)], None) if 'cpu' in names else ([], f'no core PMU under {PMU_ROOT}')  # PERF_TYPE_HARDWARE, HW_INSTRUCTIONS
    out = []
    for name in hybrid:
        try:
            typ = int(open(f'{PMU_ROOT}/{name}/type').read())
            ev = open(f'{PMU_ROOT}/{name}/events/instructions').read().strip()
            fields = dict(kv.split('=') for kv in ev.split(','))
            config = int(fields['event'], 16) | (int(fields.get('umask', '0'), 16) << 8)
        except (OSError, ValueError, KeyError) as err:
            return [], f'{name}: instructions event cannot be resolved ({type(err).__name__}: {err}); counting all-or-nothing'
        out.append((name, typ, config))
    return out, None


def open_counters(pid):
    if SYS_PERF_EVENT_OPEN is None or not os.path.isdir(PMU_ROOT):
        return {}, 'perf_event_open unavailable on this platform'
    found, why = pmus()
    if why:
        return {}, why
    libc = ctypes.CDLL(None, use_errno=True)
    fds, errors = {}, []
    for name, typ, config in found:
        a = Attr(type=typ, size=ctypes.sizeof(Attr) if ctypes.sizeof(Attr) <= 128 else 128, config=config,
                 read_format=1 | 2, flags=DISABLED | INHERIT | EXCLUDE_KERNEL | EXCLUDE_HV | ENABLE_ON_EXEC)
        fd = libc.syscall(SYS_PERF_EVENT_OPEN, ctypes.byref(a), pid, -1, -1, 0)
        if fd < 0:
            errors.append(f'{name}: errno {ctypes.get_errno()} ({os.strerror(ctypes.get_errno())})')
        else:
            fds[name] = fd
    if fds and errors:
        # All PMUs or none: a hybrid CPU with only cpu_core open would silently drop work on atom cores (review #10138).
        for fd in fds.values():
            os.close(fd)
        return {}, f'only some PMUs could be opened ({"; ".join(errors)}); counting all-or-nothing'
    if not fds:
        paranoid = None
        try:
            paranoid = open('/proc/sys/kernel/perf_event_paranoid').read().strip()
        except OSError:
            pass
        return {}, f'perf_event_open failed ({"; ".join(errors)}; perf_event_paranoid={paranoid})'
    return fds, None


def main():
    chrome = os.environ.get('LOAD_SCOREBOARD_INSTR_CHROME')
    out_path = os.environ.get('LOAD_SCOREBOARD_INSTR_OUT')
    if not chrome:
        print('instr-chrome: LOAD_SCOREBOARD_INSTR_CHROME is not set', file=sys.stderr)
        return 127
    argv = [chrome] + sys.argv[1:]
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(w)
        os.read(r, 1)  # wait until the counters are attached
        os.close(r)
        os.execv(chrome, argv)
    os.close(r)
    fds, why = open_counters(pid)
    out = open(out_path, 'w', buffering=1 << 16) if out_path else None
    if out and why:
        out.write(json.dumps({'unavailable': why}) + '\n')
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):  # pass termination on to Chrome
        signal.signal(s, lambda signum, _f: os.kill(pid, signum))
    os.write(w, b'x')
    os.close(w)
    done = threading.Event()

    def sample():
        while not done.is_set():
            counts, run, enabled, r0 = {}, {}, 0, time.perf_counter()
            for name, fd in fds.items():
                try:
                    v, en, ru = struct.unpack('QQQ', os.read(fd, 24))
                except (OSError, struct.error):
                    counts = None  # a sample missing a PMU would read as "no change" there: write none (review #10138)
                    break
                counts[name], run[name], enabled = v, ru, max(enabled, en)
            if out and counts:
                # e/r: time enabled and running (ns). Each task runs on one core type at a time, so the PMUs' running
                # times sum to the enabled time unless the PMU is multiplexed; the harness rejects windows below 99 %.
                out.write(json.dumps({'t': round(time.time() * 1000, 2), 'c': counts, 'e': enabled, 'r': run, 'readUs': round((time.perf_counter() - r0) * 1e6)}) + '\n')
            done.wait(PERIOD_S)

    th = threading.Thread(target=sample, daemon=True)
    if fds:
        th.start()
    while True:
        try:
            _, status = os.waitpid(pid, 0)
            break
        except InterruptedError:
            continue
    done.set()
    if fds:
        th.join()
        # Final totals after Chrome and all its descendants exited. (Periodic reads already include live descendants:
        # read() on an inherited event sums the live child events too, __perf_event_read_value walking child_list.)
        try:
            vals = {name: struct.unpack('QQQ', os.read(fd, 24)) for name, fd in fds.items()}
            if out:
                # After every descendant exited its times are folded in exactly: this line carries the lifetime coverage.
                out.write(json.dumps({'t': round(time.time() * 1000, 2), 'c': {n: v[0] for n, v in vals.items()}, 'e': max(v[1] for v in vals.values()),
                                      'r': {n: v[2] for n, v in vals.items()}, 'final': True}) + '\n')
        except (OSError, struct.error):
            pass  # the final totals are informational; Chrome's exit status is still returned
    if out:
        out.close()
    return os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else (status >> 8)


if __name__ == '__main__':
    code = main()
    sys.exit(128 - code if code < 0 else code)
