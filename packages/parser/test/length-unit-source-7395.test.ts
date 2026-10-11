/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7395 (3): a project length unit that defaulted to metres was reported to
 * the console only.
 *
 * Every unconfirmed 1.0 from `extractLengthUnitScale` goes through
 * `warnUnknownUnit` (#2104), but a caller of `parseColumnar` heard nothing, so
 * an IDS check could compare lengths, areas and volumes under an assumed metre
 * without knowing. The parse now sends the same reason to `onDiagnostic`, once,
 * and records `lengthUnitSource: 'declared' | 'default'` beside
 * `lengthUnitScale`. The console line stays. The four cases agreed on the
 * issue: no IFCPROJECT, no UnitsInContext, an assignment without a LENGTHUNIT,
 * and a declared metre that must stay silent.
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { IfcParser, type IfcDataStore, type LengthUnitSource } from '../src/index.js';
import { fromTransport, toTransport } from '../src/data-store-transport.js';

function source(data: string[]): ArrayBuffer {
  const text = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...data,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const WALL = "#20=IFCWALL('0000000000000000000020',$,'W-1',$,$,$,$,$,$);";
const PROJECT = (units: string) => `#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,${units});`;

const UNITS_DIAGNOSTIC = /^units: /;
const CONSOLE_LINE = '[UnitExtractor]';

async function parse(data: string[]) {
  const diagnostics: string[] = [];
  const store = await new IfcParser().parseColumnar(source(data), {
    disableWorkerScan: true,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  return { store, unitDiagnostics: diagnostics.filter((m) => UNITS_DIAGNOSTIC.test(m)) };
}

function consoleUnitLines(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((args) => String(args[0])).filter((m) => m.startsWith(CONSOLE_LINE));
}

/** The sentence both channels carry, as `warnUnknownUnit` has printed it since #2104. */
const sentence = (reason: string) => `${reason}, defaulting to meters (unconfirmed — see issue #2104)`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a defaulted project length unit is reported through onDiagnostic (#7395)', () => {
  it.each([
    ['no IFCPROJECT', [WALL], 'No IFCPROJECT found'],
    ['no UnitsInContext', [PROJECT('$'), WALL], 'No UnitsInContext reference'],
    [
      'an assignment without a LENGTHUNIT',
      [PROJECT('#3'), "#2=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);", '#3=IFCUNITASSIGNMENT((#2));', WALL],
      'No LENGTHUNIT found in IFCUNITASSIGNMENT',
    ],
  ])('%s: lengthUnitSource is default, one diagnostic, the console line stays', async (_, data, reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, unitDiagnostics } = await parse(data);

    expect(store.lengthUnitScale).toBe(1);
    expect(store.lengthUnitSource).toBe('default');
    // One onDiagnostic line, and the console line unchanged: the same sentence on both channels.
    expect(unitDiagnostics).toEqual([`units: ${sentence(reason)}`]);
    expect(consoleUnitLines(warn)).toEqual([`[UnitExtractor] ${sentence(reason)}`]);
  });

  it.each([
    ['metres', "#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);", 1],
    ['millimetres', "#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);", 0.001],
  ])('a declared unit in %s stays silent and is recorded as declared', async (_, unit, scale) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, unitDiagnostics } = await parse([PROJECT('#3'), unit, '#3=IFCUNITASSIGNMENT((#2));', WALL]);

    expect(store.lengthUnitScale).toBe(scale);
    expect(store.lengthUnitSource).toBe('declared');
    expect(unitDiagnostics).toEqual([]);
    expect(consoleUnitLines(warn)).toEqual([]);
  });

  it('carries lengthUnitSource through the worker transport', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defaulted = (await parse([WALL])).store;
    const declared = (await parse([PROJECT('#3'), "#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);", '#3=IFCUNITASSIGNMENT((#2));', WALL])).store;

    for (const [store, expected] of [[defaulted, 'default'], [declared, 'declared']] as const) {
      const restored = fromTransport(structuredClone(toTransport(store).payload), store.source);
      expect(restored.lengthUnitSource).toBe(expected);
      expect(restored.lengthUnitScale).toBe(store.lengthUnitScale);
    }
  });

  it('exports LengthUnitSource from the package index, typing IfcDataStore.lengthUnitSource', () => {
    expectTypeOf<LengthUnitSource>().toEqualTypeOf<'declared' | 'default'>();
    expectTypeOf<IfcDataStore['lengthUnitSource']>().toEqualTypeOf<LengthUnitSource | undefined>();
  });
});
