#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application, Converter, ReflectionKind } from 'typedoc';
import ts from 'typescript';
import { collectEntryPoints } from '../lib/public-entrypoints.mjs';
import { run } from '../consumer/packed-packages.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'docs/api/generated');
const scratch = mkdtempSync(join(tmpdir(), 'ifclite-api-reference-'));
try {
  // Root Turbo builds the published declarations, including sibling packages.
  // WASM types are committed, so this also works without a Rust toolchain.
  run('pnpm', ['exec', 'turbo', 'build', '--filter=./packages/*', '--concurrency=2'], root, { inherit: true, timeout: 600000 });
  const { entries, missing, packageCount } = collectEntryPoints(root);
  assert.equal(missing.length, 0, JSON.stringify(missing));
  assert.ok(entries.size > 0, 'No public declaration entry points were collected');
  const normalize = path => resolve(path).replaceAll('\\', '/');
  const surfaces = new Map([...entries].map(([name, path]) => [normalize(path), name]));
  const gpuTypes = ts.resolveTypeReferenceDirective('@webgpu/types',
    join(root, 'packages/renderer/tsconfig.json'), {}, ts.sys).resolvedTypeReferenceDirective?.resolvedFileName;
  assert.ok(gpuTypes, 'Renderer WebGPU declarations could not be resolved');
  const config = join(scratch, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ extends: join(root, 'tsconfig.json'), files: [...entries.values()], include: [], exclude: [],
    compilerOptions: { rootDir: root, noEmit: true, declaration: false, declarationMap: false,
      typeRoots: [join(root, 'node_modules/@types')], types: ['node', dirname(gpuTypes)] } }));
  const app = await Application.bootstrap({ entryPoints: [...entries.values()], tsconfig: config,
    entryPointStrategy: 'resolve', alwaysCreateEntryPointModule: true,
    name: 'IFClite TypeScript API', readme: 'none', disableSources: true,
    favicon: join(root, 'apps/landing/favicon.svg'),
    excludePrivate: true, excludeInternal: true, excludeExternals: true,
    includeVersion: false, githubPages: false,
    navigationLinks: { Guides: 'https://ifclite.dev/docs/guide/quickstart/', Packages: 'https://ifclite.dev/docs/api/typescript/' } });
  // Display real import specifiers rather than repository dist paths.
  app.converter.on(Converter.EVENT_CREATE_DECLARATION, (context, reflection) => {
    if (!reflection.kindOf(ReflectionKind.Module)) return;
    const symbol = context.getSymbolFromReflection(reflection);
    const file = symbol?.declarations?.[0]?.getSourceFile().fileName;
    const name = file && surfaces.get(normalize(file));
    if (name) reflection.name = name;
  });
  const project = await app.convert();
  assert.ok(project, 'TypeDoc could not convert the public declarations');
  let coverage;
  app.renderer.postRenderAsyncJobs.push(async () => {
    const router = app.renderer.router;
    assert.ok(router, 'TypeDoc did not provide its output router');
    const modules = project.children?.map(module => ({ surface: module.name, url: router.getFullUrl(module),
      exports: module.children?.filter(member => router.hasUrl(member)).map(member => ({ name: member.name, url: router.getFullUrl(member) })) ?? []
    })).sort((a, b) => a.surface.localeCompare(b.surface)) ?? [];
    assert.deepEqual(modules.map(module => module.surface).sort(), [...entries.keys()].sort(), 'Reference lost a public import path');
    coverage = { packageCount, entryPoints: entries.size, modules };
    writeFileSync(join(output, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n');
  });
  await app.generateDocs(project, output);
  assert.equal(app.logger.hasErrors(), false, 'TypeDoc reported an output error');
  assert.ok(coverage, 'Reference did not finish rendering');
  process.stdout.write(`API reference: ${coverage.modules.length} public modules in docs/api/generated\n`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
