#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { createBasicTemplate } from './templates/basic.js';
import { createThreejsTemplate } from './templates/threejs.js';
import { createBabylonjsTemplate } from './templates/babylonjs.js';
import { createReactTemplate } from './templates/react.js';
import { createServerTemplate } from './templates/server.js';
import { createServerNativeTemplate } from './templates/server-native.js';

/** Every template, mapped to the function that scaffolds it. */
const TEMPLATES = {
  basic: createBasicTemplate,
  threejs: createThreejsTemplate,
  babylonjs: createBabylonjsTemplate,
  react: createReactTemplate,
  server: createServerTemplate,
  'server-native': createServerNativeTemplate,
} as const;

type TemplateType = keyof typeof TEMPLATES;

const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateType[];

/**
 * `name in TEMPLATES` walks the prototype chain, so `--template toString`
 * passed the guard and then matched no branch, silently scaffolding `basic`.
 */
function isTemplate(name: string): name is TemplateType {
  return Object.hasOwn(TEMPLATES, name);
}

/**
 * Read this package's own version. A failure here is a broken install, not a
 * normal condition, so report it and return a value that reads as unknown
 * rather than a plausible number a bug report would then carry — the same
 * lesson `@ifc-lite/cli`'s `readCliVersion` records.
 */
function readOwnVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  try {
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const version = (pkg as { version?: unknown }).version;
    if (typeof version === 'string' && version.length > 0) return version;
  } catch (err) {
    console.error(`Warning: could not read ${pkgPath} (${err instanceof Error ? err.message : String(err)}).`);
    return '0.0.0-unknown';
  }
  console.error(`Warning: ${pkgPath} declares no "version".`);
  return '0.0.0-unknown';
}

function printUsage() {
  console.log(`
  create-ifc-lite - Create IFC-Lite projects instantly

  Usage:
    npx create-ifc-lite [project-name] [options]

  Options:
    -t, --template <type>   Template to use [default: basic]
    -v, --version           Print the create-ifc-lite version
    -h, --help              Show this help message

  Examples:
    npx create-ifc-lite my-ifc-app
    npx create-ifc-lite my-viewer --template threejs
    npx create-ifc-lite my-viewer --template babylonjs
    npx create-ifc-lite my-viewer --template react
    npx create-ifc-lite my-backend --template server
    npx create-ifc-lite my-backend --template server-native

  Templates:
    basic          Minimal TypeScript project for parsing IFC files
    threejs        Three.js viewer (WebGL, no WebGPU required)
    babylonjs      Babylon.js viewer (WebGL, no WebGPU required)
    react          React + Vite viewer with WebGPU rendering
    server         Docker-based IFC processing server with TypeScript client
    server-native  Native binary server (no Docker required)
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(readOwnVersion());
    process.exit(0);
  }

  // Parse arguments
  let projectName: string | undefined;
  let template: TemplateType = 'basic';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--template' || arg === '-t') {
      const value = args[++i];
      if (value === undefined || !isTemplate(value)) {
        console.error(`Invalid template: ${value ?? '(missing)'}. Available: ${TEMPLATE_NAMES.join(', ')}`);
        process.exit(1);
      }
      template = value;
    } else if (arg.startsWith('-')) {
      // Previously ignored, which made `--templat react` scaffold a project
      // literally named "react" instead of reporting the typo.
      console.error(`Unknown option: ${arg}\nRun \`npx create-ifc-lite --help\` to see the available options.`);
      process.exit(1);
    } else if (projectName === undefined) {
      projectName = arg;
    } else {
      console.error(`Unexpected argument: ${arg}. Only one project name is accepted.`);
      process.exit(1);
    }
  }

  projectName ??= 'my-ifc-app';

  // Reject path separators, '..', and names that would yield an invalid npm
  // `name`, so join(process.cwd(), projectName) stays under cwd and the
  // generated package.json is valid. Mirrors config-fixers.ts VALID_PACKAGE_NAME.
  const VALID_PROJECT_NAME = /^(?:@[\w.-]+\/)?[\w.-]+$/;
  // A scoped name like `@scope/..` passes the char regex but its last segment
  // is a dot-segment that `join(cwd, name)` resolves outside the intended dir,
  // so reject any `.`/`..` segment (scoped or not), not just a bare projectName.
  const hasDotSegment = projectName.split('/').some((seg) => seg === '.' || seg === '..');
  if (!VALID_PROJECT_NAME.test(projectName) || hasDotSegment) {
    console.error(`Invalid project name "${projectName}". Use letters, digits, '.', '-' or '_' (no path separators).`);
    process.exit(1);
  }

  const targetDir = join(process.cwd(), projectName);

  if (existsSync(targetDir)) {
    console.error(`Directory "${projectName}" already exists.`);
    process.exit(1);
  }

  console.log(`\n  Creating IFC-Lite project in ${targetDir}...\n`);

  mkdirSync(targetDir, { recursive: true });
  try {
    TEMPLATES[template](targetDir, projectName);
  } catch (error) {
    // Templates resolve their dependency versions from the npm registry as
    // their first act, so an offline run fails AFTER the directory exists.
    // Leaving it behind made the obvious retry fail with "already exists".
    rmSync(targetDir, { recursive: true, force: true });
    throw error;
  }

  console.log(`  Done! Next steps:\n`);
  console.log(`    cd ${projectName}`);

  if (template === 'server') {
    console.log(`    docker compose up -d`);
    console.log(`    npm install && npm run example ./your-model.ifc`);
    console.log(`\n  Server will be available at http://localhost:3001`);
  } else if (template === 'server-native') {
    console.log(`    npm install`);
    console.log(`    npm run server:start`);
    console.log(`\n  Server will be available at http://localhost:8080`);
  } else {
    console.log(`    npm install`);
    if (template === 'react' || template === 'threejs' || template === 'babylonjs') {
      console.log(`    npm run dev`);
    } else {
      console.log(`    npm run parse ./your-model.ifc`);
    }
  }
  console.log();
}

main().catch((error) => {
  if (error instanceof Error) {
    console.error(`\n  ${error.message}`);
    const cause = error.cause;
    if (cause instanceof Error) console.error(`  Caused by: ${cause.message}`);
    console.error();
  } else {
    console.error(error);
  }
  process.exit(1);
});
