#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import { createBasicTemplate } from './templates/basic.js';
import { createThreejsTemplate } from './templates/threejs.js';
import { createBabylonjsTemplate } from './templates/babylonjs.js';
import { createReactTemplate } from './templates/react.js';
import { createServerTemplate } from './templates/server.js';
import { createServerNativeTemplate } from './templates/server-native.js';

const TEMPLATES = {
  basic: 'basic',
  threejs: 'threejs',
  babylonjs: 'babylonjs',
  react: 'react',
  server: 'server',
  'server-native': 'server-native',
} as const;

type TemplateType = keyof typeof TEMPLATES;

function printUsage() {
  console.log(`
  create-ifc-lite - Create IFC-Lite projects instantly

  Usage:
    npx create-ifc-lite [project-name] [options]

  Options:
    --template <type>   Template to use [default: basic]
    --help              Show this help message

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

  // Parse arguments
  let projectName = 'my-ifc-app';
  let template: TemplateType = 'basic';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--template' || arg === '-t') {
      const t = args[++i] as TemplateType;
      if (t && t in TEMPLATES) {
        template = t;
      } else {
        console.error(`Invalid template: ${t}. Available: basic, threejs, babylonjs, react, server, server-native`);
        process.exit(1);
      }
    } else if (!arg.startsWith('-')) {
      projectName = arg;
    }
  }

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

  if (template === 'threejs') {
    mkdirSync(targetDir, { recursive: true });
    createThreejsTemplate(targetDir, projectName);
  } else if (template === 'babylonjs') {
    mkdirSync(targetDir, { recursive: true });
    createBabylonjsTemplate(targetDir, projectName);
  } else if (template === 'react') {
    mkdirSync(targetDir, { recursive: true });
    createReactTemplate(targetDir, projectName);
  } else if (template === 'server') {
    mkdirSync(targetDir, { recursive: true });
    createServerTemplate(targetDir, projectName);
  } else if (template === 'server-native') {
    mkdirSync(targetDir, { recursive: true });
    createServerNativeTemplate(targetDir, projectName);
  } else {
    mkdirSync(targetDir, { recursive: true });
    createBasicTemplate(targetDir, projectName);
  }

  console.log(`  Done! Next steps:\n`);
  console.log(`    cd ${projectName}`);

  if (template === 'server') {
    console.log(`    docker compose up -d`);
    console.log(`    npm install && npm run example`);
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
  console.error(error instanceof Error ? `\n  ${error.message}\n` : error);
  process.exit(1);
});
