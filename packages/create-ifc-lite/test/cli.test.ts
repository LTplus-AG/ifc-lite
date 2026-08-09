/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

/**
 * The scaffolder is a bin with no exports, so its argument parsing and its
 * project-name guard can only be exercised by running it. Every run here uses a
 * throwaway temp directory as cwd, and `npm` is shadowed by a stub that fails
 * immediately, so no test ever reaches the network or writes outside the temp
 * directory. Runs that get past validation are asserted on the banner the CLI
 * prints BEFORE any template work begins.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '../src/index.ts');
// Resolve tsx from THIS package, not from the spawned process's cwd (a temp dir
// with no node_modules), otherwise `node --import tsx` cannot find the loader.
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx');

let workDir: string;
let stubBin: string;

beforeAll(() => {
  // A fake `npm` that exits non-zero at once, so template scaffolding cannot
  // reach the real registry from a unit test.
  stubBin = mkdtempSync(join(tmpdir(), 'ifclite-stubbin-'));
  const npmStub = join(stubBin, 'npm');
  writeFileSync(npmStub, '#!/bin/sh\necho "registry disabled in tests" >&2\nexit 1\n');
  chmodSync(npmStub, 0o755);
});

beforeEach(() => {
  // realpath: on macOS /var is a symlink to /private/var and the child's
  // process.cwd() reports the resolved form.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'ifclite-create-')));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function run(args: string[]) {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(TSX_LOADER).href, CLI, ...args], {
    cwd: workDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      npm_config_registry: 'http://127.0.0.1:1/',
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('project name validation', () => {
  const rejected = [
    ['../evil', 'parent traversal'],
    ['../../etc', 'multi-level traversal'],
    ['..', 'a bare parent reference'],
    ['.', 'the current directory'],
    ['foo/bar', 'a nested path'],
    ['/tmp/absolute', 'an absolute path'],
    ['a/../b', 'traversal in the middle'],
    ['@scope/..', 'a scoped name whose last segment is a dot-segment'],
    ['@scope/.', 'a scoped name ending in a single dot-segment'],
    ['~/home', 'a tilde path'],
    ['name with spaces', 'whitespace'],
    ['proj;rm -rf /', 'shell metacharacters'],
    ['name$(id)', 'command substitution'],
    ['back\\slash', 'a backslash separator'],
  ] as const;

  for (const [name, why] of rejected) {
    it(`rejects ${why}: ${JSON.stringify(name)}`, () => {
      const { status, stderr } = run([name]);
      expect(stderr).toContain('Invalid project name');
      expect(status).toBe(1);
    });
  }

  it('creates nothing anywhere when the name is rejected', () => {
    const outside = join(workDir, 'outside');
    mkdirSync(outside);
    const inner = join(outside, 'inner');
    mkdirSync(inner);
    const before = readdirSync(outside);

    const { status } = run(['../evil']);
    expect(status).toBe(1);
    expect(readdirSync(outside)).toEqual(before);
    expect(existsSync(join(workDir, 'evil'))).toBe(false);
    expect(existsSync(resolve(workDir, '../evil'))).toBe(false);
    void inner;
  });

  const accepted = [
    'my-ifc-app',
    'my_app',
    'app.v2',
    'App123',
    '@scope/pkg',
    '@my.scope/my-pkg',
  ];

  for (const name of accepted) {
    it(`accepts ${JSON.stringify(name)} and targets it under cwd`, () => {
      const { stdout, stderr } = run([name]);
      expect(stderr).not.toContain('Invalid project name');
      expect(stdout).toContain(`Creating IFC-Lite project in ${join(workDir, name)}`);
    });
  }

  it('defaults the project name to my-ifc-app when none is given', () => {
    const { stdout } = run([]);
    expect(stdout).toContain(`Creating IFC-Lite project in ${join(workDir, 'my-ifc-app')}`);
  });
});

describe('existing directory protection', () => {
  it('refuses to scaffold into an existing directory', () => {
    mkdirSync(join(workDir, 'taken'));
    const { status, stderr } = run(['taken']);
    expect(stderr).toContain('Directory "taken" already exists.');
    expect(status).toBe(1);
  });

  it('refuses even when the existing directory is empty', () => {
    mkdirSync(join(workDir, 'empty-dir'));
    expect(readdirSync(join(workDir, 'empty-dir'))).toEqual([]);
    expect(run(['empty-dir']).status).toBe(1);
  });

  it('refuses when the name collides with an existing FILE', () => {
    writeFileSync(join(workDir, 'afile'), 'x');
    const { status, stderr } = run(['afile']);
    expect(stderr).toContain('already exists');
    expect(status).toBe(1);
  });

  it('does not touch the contents of the existing directory', () => {
    const dir = join(workDir, 'taken');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'precious');
    run(['taken']);
    expect(readdirSync(dir)).toEqual(['keep.txt']);
  });

  it('proceeds when the directory does not exist', () => {
    const { stdout } = run(['fresh']);
    expect(stdout).toContain('Creating IFC-Lite project in');
  });
});

describe('template flag parsing', () => {
  for (const template of ['basic', 'threejs', 'babylonjs', 'react', 'server', 'server-native']) {
    it(`accepts --template ${template}`, () => {
      const { stderr } = run(['proj', '--template', template]);
      expect(stderr).not.toContain('Invalid template');
    });
  }

  it('accepts the -t alias', () => {
    const { stderr } = run(['proj', '-t', 'threejs']);
    expect(stderr).not.toContain('Invalid template');
  });

  it('rejects an unknown template and names it', () => {
    const { status, stderr } = run(['proj', '--template', 'svelte']);
    expect(stderr).toContain('Invalid template: svelte');
    expect(status).toBe(1);
  });

  it('rejects --template with no value', () => {
    const { status, stderr } = run(['proj', '--template']);
    expect(stderr).toContain('Invalid template');
    expect(status).toBe(1);
  });

  // KNOWN DEFECT, pinned rather than fixed here (behaviour change is the
  // maintainer's call): the guard is `t in TEMPLATES`, and `in` walks the
  // prototype chain, so every Object.prototype key is accepted as a template
  // name. None of the `if (template === ...)` branches then match, so the user
  // silently gets the `basic` scaffold instead of an "Invalid template" error.
  for (const protoKey of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    it(`KNOWN DEFECT: --template ${protoKey} is accepted and silently scaffolds basic`, () => {
      const { stderr } = run(['proj', '--template', protoKey]);
      expect(stderr).not.toContain('Invalid template');
    });
  }

  it('consumes the template value so it is not mistaken for the project name', () => {
    const { stdout } = run(['--template', 'threejs', 'named']);
    expect(stdout).toContain(`Creating IFC-Lite project in ${join(workDir, 'named')}`);
  });

  it('does not treat the template value as the project name when the name is omitted', () => {
    const { stdout } = run(['--template', 'react']);
    expect(stdout).toContain(`Creating IFC-Lite project in ${join(workDir, 'my-ifc-app')}`);
  });

  it('never treats a flag-looking argument as the project name', () => {
    const { stdout, stderr } = run(['--verbose']);
    expect(stderr).not.toContain('Invalid project name');
    expect(stdout).toContain(`Creating IFC-Lite project in ${join(workDir, 'my-ifc-app')}`);
  });

  it('lets a later positional argument win over an earlier one', () => {
    const { stdout } = run(['first', 'second']);
    expect(stdout).toContain(`Creating IFC-Lite project in ${join(workDir, 'second')}`);
  });
});

describe('help', () => {
  it('prints usage and exits 0 for --help', () => {
    const { status, stdout } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('create-ifc-lite - Create IFC-Lite projects instantly');
  });

  it('prints usage and exits 0 for -h', () => {
    const { status, stdout } = run(['-h']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage:');
  });

  it('lists every template in the help text', () => {
    const { stdout } = run(['--help']);
    for (const template of ['basic', 'threejs', 'babylonjs', 'react', 'server', 'server-native']) {
      expect(stdout).toContain(template);
    }
  });

  it('help wins over an otherwise-invalid project name and creates nothing', () => {
    const { status, stdout } = run(['../evil', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(existsSync(resolve(workDir, '../evil'))).toBe(false);
  });
});
