/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Like scripts/lib/tla-entry-graph.mjs, follow static imports AND re-exports,
// never dynamic imports. Parse TypeScript here to check without a viewer build.
// This is an architectural dependency contract, not a source-string assertion.
it('IFC-only startup has no eager Gaussian backend or decoder dependency (#8565)', () => {
  const viewer = fileURLToPath(new URL('../..', import.meta.url));
  const repo = resolve(viewer, '../..');
  const configFile = ts.readConfigFile(resolve(viewer, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, viewer);
  const queue = [resolve(viewer, 'src/main.tsx')];
  const visited = new Set<string>();
  const violations: string[] = [];
  const host = ts.createModuleResolutionCache(repo, path => path, options);
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    // Erase type-only and unused type bindings as the runtime build does.
    const emitted = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file, compilerOptions: { ...options, module: ts.ModuleKind.ESNext, sourceMap: false },
    }).outputText;
    const ast = ts.createSourceFile(file + '.js', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const specifier = node.moduleSpecifier.text;
      const edge = `${relative(repo, file)} -> ${specifier}`;
      if (specifier.startsWith('@luma.gl/') || /gaussianDecode(?:\.worker)?(?:\.|$)/.test(specifier)
        || specifier.includes('gaussian-luma-backend')) violations.push(edge);
      // External packages/assets/virtual icons are leaves; workspace packages
      // must resolve, so an alias change cannot silently stop the graph walk.
      if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('@ifc-lite/')) continue;
      if (/\.(css|svg|png|jpg|wasm|wgsl)(\?|$)/.test(specifier) || specifier.includes('?')) continue;
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys, host).resolvedModule;
      assert.ok(resolved, `Unresolved eager dependency: ${edge}`);
      let target = resolved.resolvedFileName;
      // Packages not path-mapped by the viewer resolve to built declarations.
      // Walk their source counterpart rather than letting dist hide an edge.
      if (target.includes('/packages/') && target.includes('/dist/')) {
        let source = target.replace('/dist/', '/src/').replace(/\.d\.ts$/, '.ts').replace(/\.js$/, '.ts');
        if (source.includes('/codegen/src/generated/')) source = source.replace('/codegen/src/generated/', '/codegen/generated/');
        assert.ok(existsSync(source), `No workspace source for ${edge}: ${source}`);
        target = source;
      }
      if (!target.includes('/node_modules/') && !target.endsWith('.d.ts') && !target.endsWith('.json')) {
        assert.ok(target.startsWith(repo + '/'), `Dependency outside repository: ${edge}`);
        queue.push(target);
      }
    }
  }
  assert.ok(visited.has(resolve(viewer, 'src/bootstrap.tsx')), 'walk the real viewer bootstrap');
  assert.ok(visited.has(resolve(viewer, 'src/hooks/useIfcLoader.ts')), 'walk the canonical IFC loader');
  assert.ok(visited.has(resolve(repo, 'packages/renderer/src/index.ts')), 'walk the renderer barrel');
  assert.deepEqual(violations, [], 'Gaussian code must stay behind dynamic imports:\n' + violations.join('\n'));
});
