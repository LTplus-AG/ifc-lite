/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `config-fixers` shells out to `npm view` to resolve published versions. That
 * is mocked here, so no test touches the registry; the filesystem work happens
 * in a temp directory that is removed afterwards.
 */

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFileSync: execFileSyncMock,
}));

type Fixers = typeof import('../src/utils/config-fixers.js');

let fixers: Fixers;
let dir: string;

/**
 * Route `npm view <pkg> versions --json` and `npm view <pkg>@<v> dependencies
 * --json` to fixture data. `versions` lists the published versions of a package
 * (oldest first, as npm returns them); `deps` maps "<pkg>@<version>" to that
 * version's dependency map.
 */
function stubRegistry(
  versions: Record<string, string[]>,
  deps: Record<string, Record<string, string>> = {}
) {
  execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
    const viewArgs = args[0] === '/d' ? args.slice(4) : args;
    const [, spec, field] = viewArgs;
    if (field === 'versions') {
      return Buffer.from(JSON.stringify(versions[spec] ?? []));
    }
    if (field === 'dependencies') {
      return Buffer.from(JSON.stringify(deps[spec] ?? {}));
    }
    throw new Error(`unexpected npm view field: ${field}`);
  });
}

beforeEach(async () => {
  vi.resetModules();
  execFileSyncMock.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'ifclite-fixers-'));
  fixers = await import('../src/utils/config-fixers.js');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('getPackageVersion', () => {
  it('returns the newest installable version as a caret range', () => {
    stubRegistry({ '@ifc-lite/parser': ['1.0.0', '1.1.0', '1.2.0'] });
    expect(fixers.getPackageVersion('@ifc-lite/parser')).toBe('^1.2.0');
  });

  it('prefers the newest of the candidates, not the oldest', () => {
    stubRegistry({ pkg: ['0.1.0', '9.9.9'] });
    expect(fixers.getPackageVersion('pkg')).toBe('^9.9.9');
  });

  it('only considers the last 10 published versions', () => {
    // 12 published; the two oldest must be out of reach even if everything
    // newer were uninstallable.
    const versions = Array.from({ length: 12 }, (_, i) => `1.0.${i}`);
    const deps: Record<string, Record<string, string>> = {};
    for (const v of versions.slice(2)) {
      deps[`pkg@${v}`] = { '@ifc-lite/core': '^2.0.0' };
    }
    stubRegistry({ pkg: versions, '@ifc-lite/core': [] }, deps);
    expect(() => fixers.getPackageVersion('pkg')).toThrow(/Failed to resolve the latest published version of pkg/);
  });

  it('reaches back through the candidate window to the newest installable version', () => {
    stubRegistry(
      { pkg: ['1.0.0', '1.0.1', '1.0.2'], '@ifc-lite/core': ['2.0.0'] },
      {
        'pkg@1.0.2': { '@ifc-lite/core': '^9.9.9' },
        'pkg@1.0.1': { '@ifc-lite/core': '^2.0.0' },
      }
    );
    expect(fixers.getPackageVersion('pkg')).toBe('^1.0.1');
  });

  it('skips a version whose @ifc-lite dependency was never published', () => {
    stubRegistry(
      { pkg: ['1.0.0', '2.0.0'], '@ifc-lite/core': ['1.0.0'] },
      { 'pkg@2.0.0': { '@ifc-lite/core': '^7.7.7' }, 'pkg@1.0.0': { '@ifc-lite/core': '^1.0.0' } }
    );
    expect(fixers.getPackageVersion('pkg')).toBe('^1.0.0');
  });

  it('ignores non-@ifc-lite dependencies entirely when judging installability', () => {
    stubRegistry({ pkg: ['1.0.0'] }, { 'pkg@1.0.0': { react: '^99.0.0', three: '^0.1.0' } });
    expect(fixers.getPackageVersion('pkg')).toBe('^1.0.0');
    // React's own published versions must never have been queried.
    const queried = execFileSyncMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(queried.some((q) => q.includes('react'))).toBe(false);
  });

  it('ignores an @ifc-lite dependency range with no pinnable version', () => {
    stubRegistry({ pkg: ['1.0.0'] }, { 'pkg@1.0.0': { '@ifc-lite/core': 'workspace:^' } });
    expect(fixers.getPackageVersion('pkg')).toBe('^1.0.0');
  });

  it('extracts the pinned version out of a caret range', () => {
    stubRegistry(
      { pkg: ['1.0.0'], '@ifc-lite/core': ['3.4.5'] },
      { 'pkg@1.0.0': { '@ifc-lite/core': '^3.4.5' } }
    );
    expect(fixers.getPackageVersion('pkg')).toBe('^1.0.0');
  });

  it('rejects when a pinned dependency version is absent from the registry', () => {
    stubRegistry(
      { pkg: ['1.0.0'], '@ifc-lite/core': ['3.4.4'] },
      { 'pkg@1.0.0': { '@ifc-lite/core': '^3.4.5' } }
    );
    expect(() => fixers.getPackageVersion('pkg')).toThrow(/Failed to resolve/);
  });

  it('throws instead of emitting a placeholder when nothing is published', () => {
    stubRegistry({ pkg: [] });
    expect(() => fixers.getPackageVersion('pkg')).toThrow(/Failed to resolve the latest published version of pkg/);
  });

  it('throws with actionable text when the registry is unreachable', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('ENOTFOUND registry.npmjs.org');
    });
    expect(() => fixers.getPackageVersion('pkg')).toThrow(/Check your npm registry access/);
  });

  it('caches resolved versions so a second call makes no registry query', () => {
    stubRegistry({ pkg: ['1.0.0'] });
    expect(fixers.getPackageVersion('pkg')).toBe('^1.0.0');
    const callsAfterFirst = execFileSyncMock.mock.calls.length;
    expect(fixers.getPackageVersion('pkg')).toBe('^1.0.0');
    expect(execFileSyncMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('caches published-version lists across packages that share a dependency', () => {
    stubRegistry(
      { a: ['1.0.0'], b: ['1.0.0'], '@ifc-lite/core': ['2.0.0'] },
      { 'a@1.0.0': { '@ifc-lite/core': '^2.0.0' }, 'b@1.0.0': { '@ifc-lite/core': '^2.0.0' } }
    );
    fixers.getPackageVersion('a');
    fixers.getPackageVersion('b');
    const coreVersionQueries = execFileSyncMock.mock.calls.filter((c) => {
      const args = c[1] as string[];
      return args.includes('@ifc-lite/core') && args.includes('versions');
    });
    expect(coreVersionQueries.length).toBe(1);
  });

  it('refuses a package name that could smuggle npm flags or shell text', () => {
    stubRegistry({});
    for (const bad of ['--registry=http://evil', 'pkg; rm -rf /', 'pkg name', '../pkg', '@a/b/c']) {
      expect(() => fixers.getPackageVersion(bad)).toThrow(/Failed to resolve/);
    }
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('accepts scoped and unscoped well-formed names', () => {
    stubRegistry({ '@ifc-lite/parser': ['1.0.0'], three: ['0.160.0'] });
    expect(fixers.getPackageVersion('@ifc-lite/parser')).toBe('^1.0.0');
    expect(fixers.getPackageVersion('three')).toBe('^0.160.0');
  });

  it('invokes npm directly (no shell) on non-Windows platforms', () => {
    stubRegistry({ pkg: ['1.0.0'] });
    fixers.getPackageVersion('pkg');
    const [command, args] = execFileSyncMock.mock.calls[0];
    if (process.platform !== 'win32') {
      expect(command).toBe('npm');
      expect(args).toEqual(['view', 'pkg', 'versions', '--json']);
    } else {
      expect(args.slice(0, 4)).toEqual(['/d', '/s', '/c', 'npm']);
    }
  });

  it('bounds the registry call with a timeout', () => {
    stubRegistry({ pkg: ['1.0.0'] });
    fixers.getPackageVersion('pkg');
    expect(execFileSyncMock.mock.calls[0][2]).toMatchObject({ stdio: 'pipe', timeout: 30000 });
  });

  it('tolerates npm returning a bare string instead of an array', () => {
    execFileSyncMock.mockImplementation(() => Buffer.from(JSON.stringify('1.2.3')));
    expect(fixers.getPackageVersion('pkg')).toBe('^1.2.3');
  });
});

describe('fixPackageJson', () => {
  function writePkg(content: unknown) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(content, null, 2));
  }
  function readPkg() {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
  }

  it('does nothing when there is no package.json', () => {
    stubRegistry({});
    expect(() => fixers.fixPackageJson(dir, 'my-app')).not.toThrow();
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
  });

  it('sets the project name', () => {
    stubRegistry({});
    writePkg({ name: 'template-name', version: '0.0.0' });
    fixers.fixPackageJson(dir, 'my-app');
    expect(readPkg().name).toBe('my-app');
  });

  it('replaces workspace: ranges with the published version', () => {
    stubRegistry({ '@ifc-lite/parser': ['1.5.0'] });
    writePkg({ name: 'x', dependencies: { '@ifc-lite/parser': 'workspace:^' } });
    fixers.fixPackageJson(dir, 'my-app');
    expect(readPkg().dependencies['@ifc-lite/parser']).toBe('^1.5.0');
  });

  it('leaves non-workspace ranges untouched', () => {
    stubRegistry({ '@ifc-lite/parser': ['1.5.0'] });
    writePkg({ name: 'x', dependencies: { three: '^0.160.0', '@ifc-lite/parser': 'workspace:*' } });
    fixers.fixPackageJson(dir, 'my-app');
    expect(readPkg().dependencies.three).toBe('^0.160.0');
  });

  it('rewrites workspace ranges in every dependency field, not just dependencies', () => {
    stubRegistry({ a: ['1.0.0'], b: ['2.0.0'], c: ['3.0.0'], d: ['4.0.0'] });
    writePkg({
      name: 'x',
      dependencies: { a: 'workspace:^' },
      devDependencies: { b: 'workspace:^' },
      peerDependencies: { c: 'workspace:^' },
      optionalDependencies: { d: 'workspace:^' },
    });
    fixers.fixPackageJson(dir, 'my-app');
    const pkg = readPkg();
    expect(pkg.dependencies.a).toBe('^1.0.0');
    expect(pkg.devDependencies.b).toBe('^2.0.0');
    expect(pkg.peerDependencies.c).toBe('^3.0.0');
    expect(pkg.optionalDependencies.d).toBe('^4.0.0');
  });

  it('survives a package.json with no dependency fields at all', () => {
    stubRegistry({});
    writePkg({ name: 'x' });
    expect(() => fixers.fixPackageJson(dir, 'my-app')).not.toThrow();
  });

  it('removes a .git directory carried over from the template', () => {
    stubRegistry({});
    writePkg({ name: 'x' });
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
    fixers.fixPackageJson(dir, 'my-app');
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('keeps unrelated files when removing .git', () => {
    stubRegistry({});
    writePkg({ name: 'x' });
    writeFileSync(join(dir, '.gitignore'), 'node_modules');
    mkdirSync(join(dir, '.git'));
    fixers.fixPackageJson(dir, 'my-app');
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
  });

  it('writes the package.json back as 2-space indented JSON', () => {
    stubRegistry({});
    writePkg({ name: 'x', scripts: { dev: 'vite' } });
    fixers.fixPackageJson(dir, 'my-app');
    expect(readFileSync(join(dir, 'package.json'), 'utf-8')).toContain('\n  "scripts": {\n    "dev"');
  });

  it('propagates a resolution failure rather than writing a broken manifest', () => {
    stubRegistry({ '@ifc-lite/parser': [] });
    writePkg({ name: 'x', dependencies: { '@ifc-lite/parser': 'workspace:^' } });
    expect(() => fixers.fixPackageJson(dir, 'my-app')).toThrow(/Failed to resolve/);
    expect(readPkg().dependencies['@ifc-lite/parser']).toBe('workspace:^');
  });
});

describe('fixTsConfig / fixViteConfig / fixViewerTemplate', () => {
  it('writes a standalone tsconfig with no monorepo references', () => {
    fixers.fixTsConfig(dir);
    const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf-8'));
    expect(tsconfig.references).toBeUndefined();
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.paths['@/*']).toEqual(['./src/*']);
  });

  it('overwrites an existing tsconfig that still had references', () => {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ references: [{ path: '../parser' }] }));
    fixers.fixTsConfig(dir);
    expect(JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf-8')).references).toBeUndefined();
  });

  it('writes a vite config carrying the cross-origin isolation headers WASM needs', () => {
    fixers.fixViteConfig(dir);
    const config = readFileSync(join(dir, 'vite.config.ts'), 'utf-8');
    expect(config).toContain("'Cross-Origin-Opener-Policy': 'same-origin'");
    expect(config).toContain("'Cross-Origin-Embedder-Policy': 'credentialless'");
  });

  it('excludes the wasm packages from vite dependency pre-bundling', () => {
    fixers.fixViteConfig(dir);
    const config = readFileSync(join(dir, 'vite.config.ts'), 'utf-8');
    for (const excluded of ['@ifc-lite/wasm', '@duckdb/duckdb-wasm', 'parquet-wasm', 'esbuild-wasm']) {
      expect(config).toContain(excluded);
    }
  });

  it('registers the wasm and top-level-await plugins for workers too', () => {
    fixers.fixViteConfig(dir);
    const config = readFileSync(join(dir, 'vite.config.ts'), 'utf-8');
    expect(config).toContain('plugins: () => [wasm(), topLevelAwait()]');
    expect(config).toContain("format: 'es'");
  });

  it('fixViewerTemplate applies all three fixups', () => {
    stubRegistry({});
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'template' }));
    fixers.fixViewerTemplate(dir, 'my-app');
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).name).toBe('my-app');
    expect(existsSync(join(dir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir, 'vite.config.ts'))).toBe(true);
  });
});
