/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contracts the scaffolded projects must satisfy that only their EMITTED text
 * can express. These templates write their output as string literals, so tsc
 * and oxlint never see it; each rule below is a defect that shipped precisely
 * because nothing read those strings.
 *
 * Running the template functions instead is not an option here: every one of
 * them calls `getPackageVersion`, which shells out to `npm view`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, '../src/templates');

const TEMPLATE_FILES = readdirSync(TEMPLATE_DIR).filter((f) => extname(f) === '.ts');
/** The two templates that convert MeshData into an engine's mesh type. */
const MESH_CONVERTING_TEMPLATES = ['threejs.ts', 'babylonjs.ts'];

function read(file: string): string {
  return readFileSync(join(TEMPLATE_DIR, file), 'utf-8');
}

describe('emitted container image references', () => {
  /**
   * Docker rejects a non-lowercase repository name outright, so a template that
   * emits one fails at `docker compose up -d` — the literal first step of the
   * server template's Quick Start — with "invalid reference format". The repo's
   * own docs had the lowercase form all along; only the scaffold drifted.
   */
  it.each(TEMPLATE_FILES)('%s emits only lowercase image repositories', (file) => {
    const source = read(file);
    // @source-text-assertion-ok the emitted string IS the subject: the image ref only exists as template text
    const refs = source.match(/ghcr\.io\/[^\s'"`:]+/g) ?? [];
    for (const ref of refs) {
      expect(ref, `${file} emits "${ref}", which Docker rejects as non-lowercase`).toBe(
        ref.toLowerCase()
      );
    }
  });
});

describe('emitted mesh conversion', () => {
  /**
   * `MeshData.positions` are relative to a per-element `origin` (the local frame
   * that keeps building-scale coordinates inside f32 precision). On a typical
   * model most elements carry one, so a converter that drops it scatters the
   * building into disconnected pieces. Both viewer templates shipped that way
   * while the tutorials they link to showed the one-line fix.
   */
  it.each(MESH_CONVERTING_TEMPLATES)('%s folds the per-element origin', (file) => {
    const source = read(file);
    // @source-text-assertion-ok the converter exists only as emitted template text, so its source is the only subject available
    expect(source, `${file} converts MeshData without reading .origin`).toMatch(/\.origin/);
  });
});

describe('emitted package.json', () => {
  /**
   * A scaffold's postinstall runs in the developer's project on every install.
   * The only one that ever existed here rewrote a file inside
   * `node_modules/@ifc-lite/geometry` to patch a worker specifier that the
   * published dist had already stopped containing, so it was a no-op that
   * taught "patch your dependencies".
   */
  it.each(TEMPLATE_FILES)('%s scaffolds no postinstall hook', (file) => {
    // @source-text-assertion-ok the scaffolded package.json is built as an object literal in this source
    expect(read(file)).not.toMatch(/postinstall:/);
  });

  /**
   * A new project starts at 0.1.0. The basic template derived its version from
   * the resolved `@ifc-lite/parser` range instead, so a fresh scaffold was born
   * at whatever major the parser happened to be on.
   */
  it.each(TEMPLATE_FILES)('%s scaffolds version 0.1.0', (file) => {
    const source = read(file);
    // @source-text-assertion-ok the scaffolded version literal only exists in this source
    const versions = source.match(/^\s{4}version: (.+),$/m);
    if (versions) expect(versions[1], `${file} scaffolds ${versions[1]}`).toBe("'0.1.0'");
  });
});
