/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPackageVersion } from '../utils/config-fixers.js';
import { writeGitignore } from '../utils/gitignore.js';

/**
 * Scaffold a minimal TypeScript project for parsing IFC files.
 */
export function createBasicTemplate(targetDir: string, projectName: string) {
  const parserVersion = getPackageVersion('@ifc-lite/parser');
  // `store.entityIndex.byType` is keyed by the raw STEP spelling, and the
  // PascalCase lookup table for it lives in @ifc-lite/data.
  const dataVersion = getPackageVersion('@ifc-lite/data');

  // package.json
  writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
    name: projectName,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      parse: 'tsx src/index.ts',
      build: 'tsc',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@ifc-lite/data': dataVersion,
      '@ifc-lite/parser': parserVersion,
    },
    devDependencies: {
      '@types/node': '^22.0.0',
      typescript: '^5.3.0',
      tsx: '^4.0.0',
    },
  }, null, 2));

  // tsconfig.json
  writeFileSync(join(targetDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
      types: ['node'],
    },
    include: ['src'],
  }, null, 2));

  // src/index.ts
  mkdirSync(join(targetDir, 'src'));
  writeFileSync(join(targetDir, 'src', 'index.ts'), `import { IfcParser } from '@ifc-lite/parser';
import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { existsSync, readFileSync } from 'fs';

// Example: Parse an IFC file
const ifcPath = process.argv[2];

if (!ifcPath) {
  console.log('Usage: npm run parse <path-to-ifc-file>');
  console.log('');
  console.log('Example:');
  console.log('  npm run parse ./model.ifc');
  process.exit(1);
}

if (!existsSync(ifcPath)) {
  console.error(\`File not found: \${ifcPath}\`);
  process.exit(1);
}

// readFileSync returns a Node Buffer (Uint8Array subclass) that may be a view
// into a larger pooled allocation, so slice out just this file's bytes.
const nodeBuffer = readFileSync(ifcPath);
const buffer = nodeBuffer.buffer.slice(
  nodeBuffer.byteOffset,
  nodeBuffer.byteOffset + nodeBuffer.byteLength,
) as ArrayBuffer;

const parser = new IfcParser();

console.log('Parsing IFC file...');

try {
  const store = await parser.parseColumnar(buffer);

  // parseColumnar tolerates garbage input rather than throwing, so an empty
  // store is how "that wasn't an IFC file" actually arrives.
  if (store.entityCount === 0) {
    throw new Error(\`No IFC entities found in \${ifcPath} — is it a STEP/IFC file?\`);
  }

  console.log('\\nFile parsed successfully!');
  console.log(\`  Entities: \${store.entityCount}\`);
  console.log(\`  Schema: \${store.schemaVersion}\`);

  // Count by type. \`entityIndex.byType\` is keyed by the raw STEP spelling
  // (IFCWALLSTANDARDCASE); IFC_ENTITY_NAMES maps that to the canonical IFC
  // EXPRESS name (IfcWallStandardCase), which is what belongs in front of a
  // user. Geometry resource entities are not in \`store.entities\`, so the
  // per-entity \`getTypeName\` would answer 'Unknown' for most of this list.
  const typeCounts = [...store.entityIndex.byType.entries()]
    .map(([stepName, ids]) => [IFC_ENTITY_NAMES[stepName] ?? stepName, ids.length] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log('\\nTop entity types:');
  for (const [type, count] of typeCounts) {
    console.log(\`  \${type}: \${count}\`);
  }
} catch (error) {
  console.error(\`\\nFailed to parse \${ifcPath}: \${error instanceof Error ? error.message : String(error)}\`);
  process.exitCode = 1;
}
`);

  writeGitignore(targetDir);

  // README
  writeFileSync(join(targetDir, 'README.md'), `# ${projectName}

IFC parser project using [IFC-Lite](https://github.com/LTplus-AG/ifc-lite).

## Quick Start

\`\`\`bash
npm install
npm run parse ./your-model.ifc
\`\`\`

## Learn More

- [IFC-Lite Documentation](https://ifclite.dev/docs/)
- [TypeScript API Reference](https://ifclite.dev/docs/api/typescript/)
`);
}
