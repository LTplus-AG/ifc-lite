/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/perf/elf-rw-loads.mjs (#7955).
 *
 * The program headers below are real: CI_8359 is the perf_probe the
 * "Native instruction counts" job built for the 27.1.1 version PR #8359
 * (valgrind read none of its symbols, so no phase marker fired); LOCAL_8359
 * is the same tree built elsewhere, whose second writable load sits at a
 * different vaddr-offset delta and works.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergedWritableLoads, parseLoads } from './elf-rw-loads.mjs';

const HEADER = `Program Headers:
  Type           Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align
  PHDR           0x000040 0x0000000000000040 0x0000000000000040 0x0002a0 0x0002a0 R   0x8
`;

const CI_8359 = `${HEADER}  LOAD           0x000000 0x0000000000000000 0x0000000000000000 0x0e917c 0x0e917c R   0x1000
  LOAD           0x0e9180 0x00000000000ea180 0x00000000000ea180 0x4aa700 0x4aa700 R E 0x1000
  LOAD           0x593880 0x0000000000595880 0x0000000000595880 0x021780 0x021780 RW  0x1000
  LOAD           0x5b5000 0x00000000005b7000 0x00000000005b7000 0x000d10 0x000e40 RW  0x1000
  GNU_RELRO      0x593880 0x0000000000595880 0x0000000000595880 0x021780 0x021780 R   0x1
`;

const LOCAL_8359 = `${HEADER}  LOAD           0x000000 0x0000000000000000 0x0000000000000000 0x0e9c9c 0x0e9c9c R   0x1000
  LOAD           0x0e9ca0 0x00000000000eaca0 0x00000000000eaca0 0x4aa700 0x4aa700 R E 0x1000
  LOAD           0x5943a0 0x00000000005963a0 0x00000000005963a0 0x021780 0x021c60 RW  0x1000
  LOAD           0x5b5b20 0x00000000005b8b20 0x00000000005b8b20 0x000d10 0x000e40 RW  0x1000
  GNU_RELRO      0x5943a0 0x00000000005963a0 0x00000000005963a0 0x021780 0x021c60 R   0x1
`;

const NORELRO = `${HEADER}  LOAD           0x000000 0x0000000000000000 0x0000000000000000 0x0e917c 0x0e917c R   0x1000
  LOAD           0x0e9180 0x00000000000ea180 0x00000000000ea180 0x4aa700 0x4aa700 R E 0x1000
  LOAD           0x593880 0x0000000000595880 0x0000000000595880 0x022490 0x0225c0 RW  0x1000
`;

test('reads every PT_LOAD and its writability', () => {
  const loads = parseLoads(CI_8359);
  assert.equal(loads.length, 4);
  assert.deepEqual(loads.map((l) => l.writable), [false, false, true, true]);
  assert.deepEqual(loads[3], { offset: 0x5b5000, vaddr: 0x5b7000, filesz: 0xd10, memsz: 0xe40, writable: true });
});

test('flags the #8359 CI binary: its two writable loads map as one range', () => {
  const hazards = mergedWritableLoads(parseLoads(CI_8359));
  assert.equal(hazards.length, 1);
  assert.deepEqual(hazards[0].map((l) => l.vaddr), [0x595880, 0x5b7000]);
});

test('passes the same tree when the loads sit at different deltas', () => {
  assert.deepEqual(mergedWritableLoads(parseLoads(LOCAL_8359)), []);
});

test('a -z norelro link has one writable load and nothing to merge', () => {
  assert.deepEqual(mergedWritableLoads(parseLoads(NORELRO)), []);
});

test('a .bss tail between the loads keeps them apart', () => {
  const withTail = CI_8359.replace('0x021780 0x021780 RW', '0x021780 0x021800 RW');
  assert.deepEqual(mergedWritableLoads(parseLoads(withTail)), []);
});
