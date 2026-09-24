/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A library does not write to its consumer's console unless asked.
 *
 * `parseColumnar` used to emit ~16 unconditional `console.log` lines per call
 * -- `[IfcParser] Fast scan …` plus one `[parseLite] <phase>: Nms` per phase --
 * so the README's three-line parse snippet printed fourteen lines of internal
 * timings before its own output, and any caller writing JSON to stdout got them
 * interleaved into the payload (`console.log` is stdout in Node).
 *
 * The timings themselves are worth keeping: they are how a phase regression
 * gets found. So this pins BOTH halves of the contract -- silent by default,
 * and unchanged under `IFC_DEBUG` -- because a fix that merely deleted the
 * lines would pass the first half and quietly destroy the second.
 *
 * `onDiagnostic` is the third channel, and the one that was always correct:
 * the caller opts into it, so it must fire either way.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample, so this never needs `pnpm fixtures`.
const SAMPLE_IFC = resolve(__dirname, '../../../apps/viewer/public/samples/hello-wall.ifc');

/** Every prefix this package logs its own telemetry under. */
const TELEMETRY_PREFIX = /^\[(parseLite|IfcParser|QuantityExtractor|RelationshipExtractor)\]/;

function readSample(): ArrayBuffer {
  const buffer = readFileSync(SAMPLE_IFC);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/**
 * Parse the sample, returning the telemetry that reached the console and the
 * messages that reached `onDiagnostic`.
 */
async function parseCapturingOutput(debugEnabled: boolean) {
  const consoleLines: string[] = [];
  const diagnostics: string[] = [];
  const spies = (['log', 'debug', 'info'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
      consoleLines.push(parts.map(String).join(' '));
    })
  );

  const previous = process.env.IFC_DEBUG;
  if (debugEnabled) process.env.IFC_DEBUG = 'true';
  else delete process.env.IFC_DEBUG;

  try {
    const store = await new IfcParser().parseColumnar(readSample(), {
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(store.entityCount).toBeGreaterThan(0);
  } finally {
    if (previous === undefined) delete process.env.IFC_DEBUG;
    else process.env.IFC_DEBUG = previous;
    for (const spy of spies) spy.mockRestore();
  }

  return {
    telemetry: consoleLines.filter((line) => TELEMETRY_PREFIX.test(line)),
    diagnostics,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parser console output', () => {
  it('writes no telemetry to the console by default', async () => {
    const { telemetry } = await parseCapturingOutput(false);
    expect(telemetry).toEqual([]);
  });

  it('writes the phase timings to the console under IFC_DEBUG', async () => {
    const { telemetry } = await parseCapturingOutput(true);
    expect(telemetry.length).toBeGreaterThan(0);
    expect(telemetry.some((line) => line.startsWith('[parseLite]'))).toBe(true);
  });

  it('delivers the same phase timings to onDiagnostic either way', async () => {
    const quiet = await parseCapturingOutput(false);
    const debug = await parseCapturingOutput(true);

    // The opt-in channel is unaffected by the console gate.
    expect(quiet.diagnostics.length).toBeGreaterThan(0);
    expect(debug.diagnostics.length).toBe(quiet.diagnostics.length);

    // And every phase IFC_DEBUG prints is one the callback also reported, so
    // the two channels cannot drift apart. (Not an equality: the scanner's
    // `scan complete: …` reaches only `onDiagnostic`, and `[IfcParser] Fast
    // scan …` reaches only the console.)
    const printedPhases = debug.telemetry
      .filter((line) => line.startsWith('[parseLite] '))
      .map((line) => line.slice('[parseLite] '.length));
    expect(printedPhases.length).toBeGreaterThan(0);
    for (const phase of printedPhases) {
      expect(debug.diagnostics, `"${phase}" was printed but never reported`).toContain(phase);
    }
  });
});
