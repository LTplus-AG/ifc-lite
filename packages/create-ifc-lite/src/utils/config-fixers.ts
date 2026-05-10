/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

/** Cache of npm-resolved versions to avoid redundant registry queries. */
const versionCache = new Map<string, string>();
const publishedVersionsCache = new Map<string, Set<string>>();
const VALID_PACKAGE_NAME = /^(?:@[\w.-]+\/)?[\w.-]+$/;
const NPM_TIMEOUT_MS = 30000;
const MAX_VERSION_CANDIDATES = 10;

function readJsonFromNpm(args: string[]): unknown {
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'npm';
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args;
  const result = execFileSync(command, commandArgs, {
    stdio: 'pipe',
    timeout: NPM_TIMEOUT_MS,
  }).toString().trim();
  return result ? JSON.parse(result) : {};
}

function getPublishedVersions(packageName: string): Set<string> {
  if (!VALID_PACKAGE_NAME.test(packageName)) {
    throw new Error(`Invalid package name: ${packageName}`);
  }

  if (publishedVersionsCache.has(packageName)) {
    return publishedVersionsCache.get(packageName)!;
  }

  const json = readJsonFromNpm(['view', packageName, 'versions', '--json']);
  const versions = Array.isArray(json) ? json : [json];
  const set = new Set(versions.filter((value): value is string => typeof value === 'string'));
  publishedVersionsCache.set(packageName, set);
  return set;
}

function extractPinnedVersion(range: string): string | null {
  const match = range.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

function getVersionDependencies(packageName: string, version: string): Record<string, string> {
  const json = readJsonFromNpm(['view', `${packageName}@${version}`, 'dependencies', '--json']);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {};
  }
  return json as Record<string, string>;
}

function isInstallablePublishedVersion(packageName: string, version: string): boolean {
  const dependencies = getVersionDependencies(packageName, version);

  for (const [dependencyName, dependencyRange] of Object.entries(dependencies)) {
    if (!dependencyName.startsWith('@ifc-lite/')) continue;
    const pinnedVersion = extractPinnedVersion(dependencyRange);
    if (!pinnedVersion) continue;
    if (!getPublishedVersions(dependencyName).has(pinnedVersion)) {
      return false;
    }
  }

  return true;
}

/**
 * Fetch the latest installable published version of a specific npm package.
 * Results are cached so repeated calls for the same package are free.
 * Throws when the registry is unreachable so scaffolds never emit broken
 * placeholder versions.
 */
export function getPackageVersion(packageName: string): string {
  if (versionCache.has(packageName)) {
    return versionCache.get(packageName)!;
  }
  try {
    const versions = [...getPublishedVersions(packageName)];
    const recentVersions = versions.slice(-MAX_VERSION_CANDIDATES).reverse();
    const selectedVersion = recentVersions.find((version) =>
      isInstallablePublishedVersion(packageName, version)
    );

    if (!selectedVersion) {
      throw new Error(`No installable published version found for ${packageName}.`);
    }

    const version = `^${selectedVersion}`;
    versionCache.set(packageName, version);
    return version;
  } catch (cause) {
    throw new Error(
      `Failed to resolve the latest published version of ${packageName}. ` +
      'Check your npm registry access and try again.',
      { cause }
    );
  }
}

/**
 * Rewrite the viewer's package.json so it works as a standalone project:
 *   - Set the project name
 *   - Replace workspace: protocol versions with the latest npm version
 *   - Remove the .git directory if present
 */
export function fixPackageJson(targetDir: string, projectName: string) {
  const pkgPath = join(targetDir, 'package.json');
  if (!existsSync(pkgPath)) return;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  // Update name
  pkg.name = projectName;

  // Replace workspace protocol with the actual published version of each package.
  // Each @ifc-lite/* package is queried individually so a package that was not
  // published in the latest release does not end up with a non-existent version.
  const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

  for (const field of depFields) {
    const deps = pkg[field];
    if (!deps) continue;

    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === 'string' && version.includes('workspace:')) {
        deps[name] = getPackageVersion(name);
      }
    }
  }

  // Remove git directory if present
  const gitDir = join(targetDir, '.git');
  if (existsSync(gitDir)) {
    rmSync(gitDir, { recursive: true, force: true });
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

/**
 * Write a standalone tsconfig.json without monorepo references.
 */
export function fixTsConfig(targetDir: string) {
  const tsconfigPath = join(targetDir, 'tsconfig.json');

  // Write standalone tsconfig without monorepo references
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      baseUrl: '.',
      paths: {
        '@/*': ['./src/*']
      }
    },
    include: ['src/**/*'],
    exclude: ['node_modules']
  };

  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
}

/**
 * Write a standalone vite.config.ts with WASM support.
 */
export function fixViteConfig(targetDir: string) {
  const viteConfigPath = join(targetDir, 'vite.config.ts');

  // Write standalone vite config with WASM support
  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __RELEASE_HISTORY__: JSON.stringify([]),
    __PACKAGE_VERSIONS__: JSON.stringify([]),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    open: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    fs: {
      allow: ['..'],
    },
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: [
      '@duckdb/duckdb-wasm',
      '@ifc-lite/wasm',
      'parquet-wasm',
      'quickjs-emscripten',
      '@jitl/quickjs-wasmfile-release-asyncify',
      'esbuild-wasm',
    ],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  assetsInclude: ['**/*.wasm'],
});
`;

  writeFileSync(viteConfigPath, viteConfig);
}

/**
 * Apply all viewer-template fixups: package.json, tsconfig, vite config.
 */
export function fixViewerTemplate(targetDir: string, projectName: string) {
  fixPackageJson(targetDir, projectName);
  fixTsConfig(targetDir);
  fixViteConfig(targetDir);
}
