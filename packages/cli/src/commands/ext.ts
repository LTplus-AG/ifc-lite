/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite ext — extension management subcommands.
 *
 *   ifc-lite ext validate <path>   — Validate a manifest or bundle.
 *   ifc-lite ext init <dir>        — Scaffold a minimal extension bundle.
 *
 * Subcommands write data to stdout, status to stderr. Use --json on
 * `validate` to get structured error output suitable for machine
 * consumption (LLM repair loop, CI pipelines).
 *
 * Phase 0 deliverable. Activation/runtime subcommands arrive in later
 * phases.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  validateManifest,
  type ValidationError,
} from '@ifc-lite/extensions';
import { loadBundleFromDirectory } from '@ifc-lite/extensions/node';
import { hasFlag, fatal } from '../output.js';
import {
  extKeygenCommand,
  extPackCommand,
  extSignCommand,
  extVerifyCommand,
} from './ext-signing.js';

export async function extCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    return;
  }
  const rest = args.slice(1);
  switch (sub) {
    case 'validate':
      await extValidateCommand(rest);
      return;
    case 'init':
      await extInitCommand(rest);
      return;
    case 'keygen':
      await extKeygenCommand(rest);
      return;
    case 'pack':
      await extPackCommand(rest);
      return;
    case 'sign':
      await extSignCommand(rest);
      return;
    case 'verify':
      await extVerifyCommand(rest);
      return;
    default:
      process.stderr.write(`Unknown ext subcommand: ${sub}\n`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  process.stdout.write(`Usage: ifc-lite ext <command> [...args]

Commands:
  validate <path>          Validate a manifest.json or a bundle directory.
                           Flags: --json (machine-readable output)
  init <directory>         Scaffold a minimal extension bundle.
                           Flags: --id <id>, --name <name>
  keygen --out <prefix>    Generate an Ed25519 keypair for signing.
                           Flags: --label <name>
  pack <bundle-dir>        Pack a bundle directory into a .iflx file.
                           Flags: --out <bundle.iflx>, --sign --key <private.iflk>
  sign <bundle>            Sign a bundle directory or unsigned .iflx.
                           Flags: --key <private.iflk>, --out <bundle.iflx>
  verify <bundle.iflx>     Inspect a .iflx file. With --key, verify the
                           signature matches an expected public key.
                           Flags: --key <public.iflk>, --json

Run 'ifc-lite ext <command> --help' for command-specific options.
`);
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

async function extValidateCommand(args: string[]): Promise<void> {
  const json = hasFlag(args, '--json');
  const target = args.find((a) => !a.startsWith('-'));
  if (!target) fatal('Usage: ifc-lite ext validate <path> [--json]');
  const path = resolve(target);

  const errors = await runValidate(path);
  if (json) {
    process.stdout.write(`${JSON.stringify({
      target: path,
      ok: errors.length === 0,
      errors,
    }, null, 2)}\n`);
  } else if (errors.length === 0) {
    process.stderr.write(`✓ ${path} is valid.\n`);
  } else {
    process.stderr.write(`✗ ${path} failed validation:\n`);
    for (const err of errors) {
      const path = err.path || '<root>';
      const hint = err.hint ? ` — ${err.hint}` : '';
      process.stderr.write(`  ${path}: [${err.code}] ${err.message}${hint}\n`);
    }
  }
  process.exit(errors.length === 0 ? 0 : 1);
}

async function runValidate(path: string): Promise<ValidationError[]> {
  if (!existsSync(path)) {
    return [{
      path: '',
      code: 'invalid_reference',
      message: `Path does not exist: ${path}`,
    }];
  }

  // If the path is a JSON file, validate as manifest. Otherwise treat as
  // a bundle directory.
  if (path.toLowerCase().endsWith('.json')) {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(path, 'utf-8'));
    } catch (err) {
      return [{
        path: '',
        code: 'invalid_format',
        message: `Could not parse JSON: ${err instanceof Error ? err.message : err}`,
      }];
    }
    const result = validateManifest(json);
    return result.ok ? [] : result.errors;
  }

  const bundle = await loadBundleFromDirectory(path);
  return bundle.ok ? [] : bundle.errors;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function extInitCommand(args: string[]): Promise<void> {
  const target = args.find((a) => !a.startsWith('-'));
  if (!target) fatal('Usage: ifc-lite ext init <directory> [--id <id>] [--name <name>]');
  const dir = resolve(target);

  const id = getArg(args, '--id') ?? defaultIdFromPath(target);
  const name = getArg(args, '--name') ?? defaultNameFromPath(target);

  if (existsSync(dir)) {
    fatal(`Directory already exists: ${dir}`);
  }

  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'src', 'commands'), { recursive: true });

  const manifest = {
    manifestVersion: 1,
    id,
    name,
    description: `${name} — a starter extension scaffolded by ifc-lite ext init.`,
    version: '0.1.0',
    engines: { ifcLiteSdk: '>=2.0.0' },
    capabilities: ['model.read'],
    activation: ['onCommand:ext.starter.hello'],
    contributes: {
      commands: [
        {
          id: 'ext.starter.hello',
          title: 'Hello from starter',
        },
      ],
    },
    entry: {
      commands: {
        'ext.starter.hello': 'src/commands/hello.js',
      },
    },
  };

  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  await writeFile(join(dir, 'src', 'commands', 'hello.js'), STARTER_COMMAND, 'utf-8');
  await writeFile(join(dir, 'README.md'), starterReadme(name), 'utf-8');

  process.stderr.write(`Scaffolded extension at ${dir}\n`);
  process.stderr.write(`  id:   ${id}\n`);
  process.stderr.write(`  name: ${name}\n`);
  process.stderr.write(`Run 'ifc-lite ext validate ${target}' to verify.\n`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('-')) return undefined;
  return value;
}

function defaultIdFromPath(rawPath: string): string {
  const last = rawPath.split(/[\\/]/).filter(Boolean).pop() ?? 'starter';
  const cleaned = last.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return `com.example.${cleaned}`;
}

function defaultNameFromPath(rawPath: string): string {
  const last = rawPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Starter';
  return last
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ') || 'Starter';
}

const STARTER_COMMAND = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Hello from starter" command.
 *
 * The \`ctx\` parameter is the OCAP capability bundle the host hands to
 * every entry function. Capabilities are scoped per manifest.capabilities.
 */
export default async function hello(ctx) {
  ctx.log.info('Hello from starter');
  ctx.notify('info', 'Starter extension says hi.');
  return { message: 'hello' };
}
`;

function starterReadme(name: string): string {
  return `# ${name}

Starter extension scaffolded by \`ifc-lite ext init\`.

## Validate

\`\`\`bash
ifc-lite ext validate .
\`\`\`

## Next steps

- Replace the placeholder \`hello\` command with your real entry point.
- Declare any additional capabilities in \`manifest.json\`.
- Add tests under \`tests/\` and reference them in the manifest.

See https://louistrue.github.io/ifc-lite/ for the full extension model.
`;
}
