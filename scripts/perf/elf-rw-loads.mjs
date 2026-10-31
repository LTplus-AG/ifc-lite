#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Preflight for scripts/perf/instructions.sh (#7955): refuse a perf_probe
 * whose writable PT_LOAD segments valgrind cannot tell apart.
 *
 * Valgrind 3.22 (Ubuntu 24.04, the CI runner) reads a binary's symbols only
 * after it has seen one mapping per writable PT_LOAD. When two writable loads
 * are back to back in BOTH the file and memory (same vaddr-offset delta, no
 * .bss tail between them), its address-space manager merges them into one
 * mapping, the count is never reached, and no symbol of perf_probe is ever
 * read. Callgrind then sees only anonymous functions, so `--dump-before` on
 * the phase markers never fires and the report says "no phase markers fired"
 * although the probe ran the whole pipeline. Whether a build hits this is a
 * layout accident (the second load's file offset landing on a page boundary):
 * the 27.1.1 version PR #8359 hit it, its 27.1.0 parent did not.
 *
 * instructions.sh links perf_probe with `-z norelro`, which leaves a single
 * writable load, so the hazard cannot arise; this check keeps a future
 * linker or flag change from bringing it back as a misleading report.
 *
 *   node scripts/perf/elf-rw-loads.mjs <binary>     exit 1 on a hazard
 */

import { execFileSync } from 'node:child_process';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const PAGE = 0x1000;

function pageUp(n) {
  return Math.ceil(n / PAGE) * PAGE;
}

/** PT_LOAD rows of `readelf -lW` output, in file order. */
export function parseLoads(text) {
  const loads = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*LOAD\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+0x[0-9a-f]+\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+([RWE ]+?)\s+0x[0-9a-f]+\s*$/i);
    if (!m) continue;
    const [, offset, vaddr, filesz, memsz, flags] = m;
    loads.push({
      offset: Number(offset),
      vaddr: Number(vaddr),
      filesz: Number(filesz),
      memsz: Number(memsz),
      writable: flags.includes('W'),
    });
  }
  return loads;
}

/** Pairs of writable loads that map as one contiguous file-backed range. */
export function mergedWritableLoads(loads) {
  const hazards = [];
  const rw = loads.filter((l) => l.writable);
  for (let i = 1; i < rw.length; i++) {
    const [a, b] = [rw[i - 1], rw[i]];
    const sameDelta = a.vaddr - a.offset === b.vaddr - b.offset;
    // A .bss tail that ends inside the last file page is zeroed in place; only
    // one that spills onto a further page gets an anonymous mapping between.
    const end = pageUp(a.vaddr + a.memsz);
    const noAnonTail = pageUp(a.vaddr + a.filesz) === end;
    const adjacent = end === Math.floor(b.vaddr / PAGE) * PAGE;
    if (sameDelta && noAnonTail && adjacent) hazards.push([a, b]);
  }
  return hazards;
}

function hex(n) {
  return `0x${n.toString(16)}`;
}

if (isMainEntry(import.meta.url)) {
  const bin = process.argv[2];
  if (!bin) {
    console.error('usage: elf-rw-loads.mjs <binary>');
    process.exit(2);
  }
  let headers;
  try {
    headers = execFileSync('readelf', ['-lW', bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const why = error.code === 'ENOENT' ? 'readelf is not installed (apt install binutils)' : `readelf cannot read ${bin} (not an ELF file?)`;
    console.error(`elf-rw-loads: ${why}`);
    process.exit(2);
  }
  const loads = parseLoads(headers);
  if (loads.length === 0) {
    console.error(`elf-rw-loads: no PT_LOAD segments read from ${bin}`);
    process.exit(2);
  }
  const hazards = mergedWritableLoads(loads);
  for (const [a, b] of hazards) {
    console.error(
      `elf-rw-loads: writable loads at ${hex(a.vaddr)} and ${hex(b.vaddr)} are contiguous in file and memory; ` +
        'valgrind would merge them and read no symbols, so no phase marker could fire. ' +
        'Link perf_probe with -z norelro (instructions.sh does).',
    );
  }
  process.exit(hazards.length === 0 ? 0 : 1);
}
