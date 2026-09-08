/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * The generator locates each per-IFC-version block in the vendored
 * `SchemaInfo.*.g.cs` sources by searching for a marker. Those markers
 * prefix-alias — `GetPropertiesIFC4` is a prefix of `GetPropertiesIFC4x3`,
 * `IfcSchemaVersions.Ifc4` of `IfcSchemaVersions.Ifc4x3`,
 * `GetRelationTypesIFC4` of `GetRelationTypesIFC4x3` — so a plain
 * `indexOf` resolved a renamed or removed IFC4 marker onto the IFC4X3 one
 * rather than reporting it missing. The missing-marker throws could not
 * fire, and the generator wrote misfiled tables (IFC2X3 absorbing the
 * whole IFC4 block, the IFC4 table becoming a byte copy of IFC4X3) and
 * exited 0.
 *
 * The script has no exports — it is a bin that parses and writes on
 * import — so these run it, against a throwaway copy of the upstream data
 * whose markers are renamed one at a time. Every run writes only inside
 * its temp directory.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx');

const UPSTREAM_FILES = [
  'SchemaInfo.Attributes.g.cs',
  'SchemaInfo.ClassAndAttributeNames.g.cs',
  'SchemaInfo.MeasureNames.g.cs',
  'SchemaInfo.ObjectTypes.g.cs',
  'SchemaInfo.PartOfRelations.g.cs',
  'SchemaInfo.Properties.g.cs',
  'SchemaInfo.Schemas.g.cs',
];

let workDir: string;
let scriptPath: string;
let upstreamDir: string;
/** Pristine bytes of each upstream file, to undo a test's rename. */
const pristine = new Map<string, string>();

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), 'ifclite-schema-gen-'));
  const scriptsDir = join(workDir, 'scripts');
  upstreamDir = join(scriptsDir, 'upstream');
  fs.mkdirSync(upstreamDir, { recursive: true });
  scriptPath = join(scriptsDir, 'generate-ifc-schema.ts');
  fs.copyFileSync(resolve(__dirname, 'generate-ifc-schema.ts'), scriptPath);
  for (const name of UPSTREAM_FILES) {
    const text = fs.readFileSync(
      resolve(__dirname, 'upstream', name),
      'utf8'
    );
    pristine.set(name, text);
    fs.writeFileSync(join(upstreamDir, name), text);
  }
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const [name, text] of pristine) {
    fs.writeFileSync(join(upstreamDir, name), text);
  }
});

function rename(file: string, from: RegExp, to: string): void {
  const path = join(upstreamDir, file);
  const before = fs.readFileSync(path, 'utf8');
  const after = before.replace(from, to);
  // A rename that matched nothing would make the assertion below vacuous.
  expect(after, `${from} did not match in ${file}`).not.toBe(before);
  fs.writeFileSync(path, after);
}

/** Apply an arbitrary edit to a copied upstream file, failing if it is a no-op. */
function edit(file: string, fn: (text: string) => string): void {
  const path = join(upstreamDir, file);
  const before = fs.readFileSync(path, 'utf8');
  const after = fn(before);
  expect(after, `the edit did not change ${file}`).not.toBe(before);
  fs.writeFileSync(path, after);
}

function runGenerator(): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', TSX_LOADER, scriptPath], {
    encoding: 'utf8',
    cwd: workDir,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('generate-ifc-schema marker lookup', () => {
  it('parses the unmodified upstream into the committed per-version counts', () => {
    const r = runGenerator();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // Pinned so a stricter marker matcher that silently drops or merges a
    // block cannot pass: these are the counts the committed tables hold.
    expect(r.stdout).toContain('IFC2X3: 771 entities, 317 psets');
    expect(r.stdout).toContain('IFC4: 932 entities, 408 psets');
    expect(r.stdout).toContain('IFC4X3: 1008 entities, 760 psets');
    expect(r.stdout).toContain('psets-ifc2x3.ts — 317 psets');
    expect(r.stdout).toContain('psets-ifc4.ts — 408 psets');
    expect(r.stdout).toContain('psets-ifc4x3.ts — 760 psets');
    // IFC2X3 has no GetRelationTypesIFC2x3 method upstream at all; that
    // absence is legitimate and must stay non-fatal.
    expect(r.stdout).toContain('IFC2X3: 771 entities, 317 psets, 7 partOf relations, 0 obj→type pairs');
    expect(r.stdout).toContain('IFC4: 932 entities, 408 psets, 7 partOf relations, 132 obj→type pairs');
  });

  it.each([
    {
      what: 'GetPropertiesIFC4',
      file: 'SchemaInfo.Properties.g.cs',
      from: /GetPropertiesIFC4(?!x3)/g,
      to: 'GetPropsRenamedIFC4',
      message: 'Could not find GetPropertiesIFC4 in Properties.g.cs',
    },
    {
      what: 'GetPropertiesIFC4x3',
      file: 'SchemaInfo.Properties.g.cs',
      from: /GetPropertiesIFC4x3/g,
      to: 'GetPropsRenamedIFC4x3',
      message: 'Could not find GetPropertiesIFC4x3 in Properties.g.cs',
    },
    {
      what: 'IfcSchemaVersions.Ifc4',
      file: 'SchemaInfo.PartOfRelations.g.cs',
      from: /IfcSchemaVersions\.Ifc4(?!x3)/g,
      to: 'IfcSchemaVersions.RenamedFour',
      message: 'Could not find IfcSchemaVersions.Ifc4 in PartOfRelations.g.cs',
    },
    {
      what: 'GetRelationTypesIFC4',
      file: 'SchemaInfo.ObjectTypes.g.cs',
      from: /GetRelationTypesIFC4(?!x3)/g,
      to: 'GetRelTypesRenamedIFC4',
      message: 'Could not find GetRelationTypesIFC4 in ObjectTypes.g.cs',
    },
    {
      what: 'GetAttributesIFC4',
      file: 'SchemaInfo.Attributes.g.cs',
      from: /GetAttributesIFC4(?!x3)/g,
      to: 'GetAttrsRenamedIFC4',
      message: 'Could not find GetAttributesIFC4 in Attributes.g.cs',
    },
  ])(
    'fails naming the marker when $what is renamed, instead of aliasing onto the IFC4X3 block',
    ({ file, from, to, message }) => {
      rename(file, from, to);
      const r = runGenerator();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(message);
      expect(r.stdout).not.toContain('Done.');
    }
  );

  /**
   * Making a missing marker read as missing was only half of it. The block
   * slicing also assumes each marker occurs EXACTLY ONCE and that the markers
   * run in the order the versions are listed — and with either assumption
   * broken the START lookup still succeeds, so nothing threw and the
   * generator wrote a corrupted table and exited 0. Both were reproduced
   * against the real vendored data before the guards existed; the counts in
   * each case name what the corrupted run actually emitted.
   */
  it('refuses a second occurrence of a marker instead of slicing from it', () => {
    // The dispatcher shape: a reference to GetPropertiesIFC4 ahead of the
    // definitions. IFC4's start resolved onto it and psets-ifc4.ts was emitted
    // with 725 psets against a 408 baseline — the whole IFC2X3 block absorbed.
    edit('SchemaInfo.Properties.g.cs', (text) =>
      text.replace(
        'static IEnumerable<PropertySetInfo> GetPropertiesIFC2x3()',
        '\tvoid Dispatch() { GetPropertiesIFC4(); }\n' +
          '\tstatic IEnumerable<PropertySetInfo> GetPropertiesIFC2x3()'
      )
    );
    const r = runGenerator();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      'GetPropertiesIFC4 occurs 2 times in Properties.g.cs'
    );
    expect(r.stdout).not.toContain('Done.');
    expect(r.stdout).not.toContain('725 psets');
  });

  it('refuses an out-of-order upstream instead of running a block to EOF', () => {
    // Every end lookup searches forward from its own section's start, so an
    // IFC4X3 method placed above the IFC4 one is invisible to it: IFC2X3 ran
    // to the IFC4X3 marker (1077 psets) and IFC4X3 ran to end of file (1168).
    edit('SchemaInfo.Properties.g.cs', (text) => {
      const i4 = text.indexOf(
        'private static IEnumerable<PropertySetInfo> GetPropertiesIFC4()'
      );
      const i43 = text.indexOf(
        'private static IEnumerable<PropertySetInfo> GetPropertiesIFC4x3()'
      );
      expect(i4, 'IFC4 method anchor drifted').toBeGreaterThan(-1);
      expect(i43, 'IFC4X3 method anchor drifted').toBeGreaterThan(i4);
      return text.slice(0, i4) + text.slice(i43) + text.slice(i4, i43);
    });
    const r = runGenerator();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      'GetPropertiesIFC4x3 appears before GetPropertiesIFC4 in Properties.g.cs'
    );
    expect(r.stdout).not.toContain('Done.');
    expect(r.stdout).not.toContain('1077 psets');
  });

  // The same two guards are shared by every parser, not bolted onto the
  // Properties one: a duplicate in a sibling file must be refused too.
  it('refuses a duplicated marker in a sibling upstream file', () => {
    edit('SchemaInfo.ObjectTypes.g.cs', (text) =>
      text.replace(
        'GetRelationTypesIFC4x3',
        'GetRelationTypesIFC4x3();\n\t\t\tGetRelationTypesIFC4x3'
      )
    );
    const r = runGenerator();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      'GetRelationTypesIFC4x3 occurs 2 times in ObjectTypes.g.cs'
    );
    expect(r.stdout).not.toContain('Done.');
  });
});
