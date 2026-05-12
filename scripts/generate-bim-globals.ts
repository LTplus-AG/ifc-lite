#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate bim-globals.d.ts from NAMESPACE_SCHEMAS.
 *
 * Single source of truth: bridge-schema.ts defines all SDK methods exposed
 * to scripts. This script reads the schema and generates TypeScript
 * declarations for the `bim` global used in template scripts.
 *
 * Usage: npx tsx scripts/generate-bim-globals.ts
 */

import { NAMESPACE_SCHEMAS, type MethodSchema } from '../packages/sandbox/src/bridge-schema.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUTPUT_PATH = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  '../apps/viewer/src/lib/scripts/templates/bim-globals.d.ts',
);

/** Map an ArgType to a TypeScript type string */
function argTypeToTS(argType: string): string {
  switch (argType) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'dump': return 'unknown';
    case 'entityRefs': return 'BimEntity[]';
    case '...strings': return '...types: string[]';
    default: return 'unknown';
  }
}

/**
 * Strip a trailing ` | undefined` from a type string and flag the parameter
 * as optional — emits `name?: type` instead of the noisier `name: type | undefined`.
 */
function normalizeOptional(tsType: string): { type: string; optional: boolean } {
  const match = tsType.match(/^(.*?)\s*\|\s*undefined\s*$/);
  if (match) return { type: match[1].trim(), optional: true };
  return { type: tsType, optional: false };
}

/** Generate a TypeScript method signature from a MethodSchema */
function methodSignature(m: MethodSchema): string {
  const params: string[] = [];

  for (let i = 0; i < m.args.length; i++) {
    const argType = m.args[i];
    const overrideType = m.tsParamTypes?.[i];
    if (argType === '...strings') {
      const name = m.paramNames?.[i] ?? 'args';
      params.push(`...${name}: string[]`);
    } else {
      const name = m.paramNames?.[i] ?? `arg${i}`;
      const rawType = overrideType ?? argTypeToTS(argType);
      const { type, optional } = normalizeOptional(rawType);
      params.push(`${name}${optional ? '?' : ''}: ${type}`);
    }
  }

  // Determine return type
  let returnType: string;
  if (m.tsReturn) {
    returnType = m.tsReturn;
  } else if (m.returns === 'void') {
    returnType = 'void';
  } else if (m.returns === 'string') {
    returnType = 'string';
  } else {
    returnType = 'unknown';
  }

  return `    /** ${m.doc} */\n    ${m.name}(${params.join(', ')}): ${returnType};`;
}

// ── Generate ──────────────────────────────────────────────────────────────

const lines: string[] = [
  '/* This Source Code Form is subject to the terms of the Mozilla Public',
  ' * License, v. 2.0. If a copy of the MPL was not distributed with this',
  ' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */',
  '',
  '/**',
  ' * AUTO-GENERATED — do not edit by hand.',
  ' * Run: npx tsx scripts/generate-bim-globals.ts',
  ' *',
  ' * Type declarations for the sandbox `bim` global.',
  ' * Generated from NAMESPACE_SCHEMAS in bridge-schema.ts.',
  ' */',
  '',
  '// ── Entity types ────────────────────────────────────────────────────────',
  '',
  'interface BimEntity {',
  '  ref: { modelId: string; expressId: number };',
  '  name: string; Name: string;',
  '  type: string; Type: string;',
  '  globalId: string; GlobalId: string;',
  '  description: string; Description: string;',
  '  objectType: string; ObjectType: string;',
  '}',
  '',
  'interface BimPropertySet {',
  '  name: string;',
  '  properties: Array<{ name: string; value: string | number | boolean | null }>;',
  '}',
  '',
  'interface BimQuantitySet {',
  '  name: string;',
  '  quantities: Array<{ name: string; value: number | null }>;',
  '}',
  '',
  'interface BimAttribute {',
  '  name: string;',
  '  value: string;',
  '}',
  '',
  'interface BimClassification {',
  '  system?: string;',
  '  identification?: string;',
  '  name?: string;',
  '  location?: string;',
  '  description?: string;',
  '  path?: string[];',
  '}',
  '',
  'interface BimMaterialLayer {',
  '  materialName?: string;',
  '  thickness?: number;',
  '  isVentilated?: boolean;',
  '  name?: string;',
  '  category?: string;',
  '}',
  '',
  'interface BimMaterialProfile {',
  '  materialName?: string;',
  '  name?: string;',
  '  category?: string;',
  '}',
  '',
  'interface BimMaterialConstituent {',
  '  materialName?: string;',
  '  name?: string;',
  '  fraction?: number;',
  '  category?: string;',
  '}',
  '',
  'interface BimMaterial {',
  '  type: \'Material\' | \'MaterialLayerSet\' | \'MaterialProfileSet\' | \'MaterialConstituentSet\' | \'MaterialList\';',
  '  name?: string;',
  '  description?: string;',
  '  layers?: BimMaterialLayer[];',
  '  profiles?: BimMaterialProfile[];',
  '  constituents?: BimMaterialConstituent[];',
  '  materials?: string[];',
  '}',
  '',
  'interface BimTypeProperties {',
  '  typeName: string;',
  '  typeId: number;',
  '  properties: BimPropertySet[];',
  '}',
  '',
  'interface BimDocument {',
  '  name?: string;',
  '  description?: string;',
  '  location?: string;',
  '  identification?: string;',
  '  purpose?: string;',
  '  intendedUse?: string;',
  '  revision?: string;',
  '  confidentiality?: string;',
  '}',
  '',
  'interface BimRelationships {',
  '  voids: Array<{ id: number; name?: string; type: string }>;',
  '  fills: Array<{ id: number; name?: string; type: string }>;',
  '  groups: Array<{ id: number; name?: string }>;',
  '  connections: Array<{ id: number; name?: string; type: string }>;',
  '}',
  '',
  'interface BimModelInfo {',
  '  id: string;',
  '  name: string;',
  '  schemaVersion: string;',
  '  entityCount: number;',
  '  fileSize: number;',
  '}',
  '',
  'interface BimFileAttachment {',
  '  name: string;',
  '  type: string;',
  '  size: number;',
  '  rowCount?: number;',
  '  columns?: string[];',
  '  hasTextContent: boolean;',
  '}',
  '',
  '// ── Namespace declarations ──────────────────────────────────────────────',
  '',
  'declare const bim: {',
];

for (const ns of NAMESPACE_SCHEMAS) {
  lines.push(`  /** ${ns.doc} */`);
  lines.push(`  ${ns.name}: {`);
  for (const method of ns.methods) {
    lines.push(methodSignature(method));
  }
  lines.push('  };');
}

lines.push('};');
lines.push('');

const content = lines.join('\n');

fs.writeFileSync(OUTPUT_PATH, content, 'utf-8');
console.log(`Generated ${OUTPUT_PATH}`);
