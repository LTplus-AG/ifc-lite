/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPackageVersion } from '../utils/config-fixers.js';

/**
 * Scaffold a minimal TypeScript project for parsing IFC files.
 */
export function createBasicTemplate(targetDir: string, projectName: string) {
  const parserVersion = getPackageVersion('@ifc-lite/parser');

  // package.json
  writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
    name: projectName,
    version: parserVersion.replace('^', ''),
    type: 'module',
    scripts: {
      parse: 'npx tsx src/index.ts',
      build: 'tsc',
    },
    dependencies: {
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
import { readFileSync } from 'fs';

// Example: Parse an IFC file
const ifcPath = process.argv[2];

if (!ifcPath) {
  console.log('Usage: npm run parse <path-to-ifc-file>');
  console.log('');
  console.log('Example:');
  console.log('  npm run parse ./model.ifc');
  process.exit(1);
}

// readFileSync returns a Node Buffer (Uint8Array subclass); extract the underlying ArrayBuffer
const nodeBuffer = readFileSync(ifcPath);
const buffer = nodeBuffer.buffer.slice(
  nodeBuffer.byteOffset,
  nodeBuffer.byteOffset + nodeBuffer.byteLength,
) as ArrayBuffer;

const parser = new IfcParser();

console.log('Parsing IFC file...');
parser.parseColumnar(buffer).then(store => {
  console.log('\\nFile parsed successfully!');
  console.log(\`  Entities: \${store.entityCount}\`);
  console.log(\`  Schema: \${store.schemaVersion}\`);

  // Count by type
  const typeCounts = [...store.entityIndex.byType.entries()]
    .map(([type, ids]) => [type, ids.length] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log('\\nTop entity types:');
  for (const [type, count] of typeCounts) {
    console.log(\`  \${type}: \${count}\`);
  }
});
`);

  // README
  writeFileSync(join(targetDir, 'README.md'), `# ${projectName}

IFC parser project using [IFC-Lite](https://github.com/LTplus-AG/ifc-lite).

## Quick Start

\`\`\`bash
npm install
npm run parse ./your-model.ifc
\`\`\`

## Learn More

- [IFC-Lite Documentation](https://ltplus-ag.github.io/ifc-lite/)
- [API Reference](https://ltplus-ag.github.io/ifc-lite/api/)
`);
}
