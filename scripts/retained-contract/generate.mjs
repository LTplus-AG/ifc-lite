// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema, causes } from './schema.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { cases } from './cases.mjs';
import { demand } from './validate.mjs';

export const roots = ['Options', 'Refusal', 'ModelReport', 'InspectionReport'];
const directory = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(directory, '../..');
const quote = JSON.stringify;
const snake = (text) => text.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
const variant = (text) => text.toLowerCase().split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
const keys = (value, allowed) => demand(Object.keys(value).every((key) => allowed.includes(key)), 'schema keys');

export function validateSchema(input) {
  keys(input, ['version', 'maxWireBytes', 'types']);
  demand(input.version === 1 && input.maxWireBytes === 4194304, 'schema version/bound');
  const entries = Object.entries(input.types);
  demand(entries.length > 0, 'schema types');
  const visit = (name, path = []) => {
    demand(Object.hasOwn(input.types, name) && !path.includes(name), 'schema reference/cycle');
    const node = input.types[name];
    const refs = [];
    switch (node.kind) {
      case 'record':
        keys(node, ['kind', 'fields']);
        demand(new Set(Object.keys(node.fields).map(snake)).size === Object.keys(node.fields).length, 'field collision');
        for (const [field, ref] of Object.entries(node.fields)) {
          demand(/^[a-zA-Z][a-zA-Z0-9]*$/u.test(field), 'schema field'); refs.push(ref);
        }
        break;
      case 'union':
        keys(node, ['kind', 'tag', 'variants']);
        demand(/^[a-z][a-zA-Z]*$/u.test(node.tag), 'schema tag');
        for (const [tag, ref] of Object.entries(node.variants)) {
          demand(/^[a-z][a-z_]*$/u.test(tag), 'variant');
          demand(input.types[ref]?.kind === 'record' && !Object.hasOwn(input.types[ref].fields, node.tag), 'tag collision');
          refs.push(ref);
        }
        demand(refs.length > 0, 'union variants'); break;
      case 'list':
        keys(node, ['kind', 'item', 'min', 'max']);
        demand(Number.isSafeInteger(node.min) && Number.isSafeInteger(node.max) && node.min >= 0 && node.max >= node.min && node.max <= 4096, 'list bound');
        refs.push(node.item); break;
      case 'text':
        keys(node, ['kind', 'format']);
        demand(['hash', 'commit', 'u64', 'positive_u64', 'global_id'].includes(node.format), 'format'); break;
      case 'number':
        keys(node, ['kind', 'minExclusive', 'max']);
        demand(Number.isFinite(node.minExclusive) && Number.isFinite(node.max) && node.max > node.minExclusive, 'number bounds'); break;
      case 'enum':
        keys(node, ['kind', 'values']);
        demand(node.values.length > 0 && node.values.every((v) => typeof v === 'string' && /^[A-Za-z][A-Za-z_]*$/u.test(v)), 'enum');
        demand(new Set(node.values.map(variant)).size === node.values.length, 'enum collision'); break;
      case 'literal':
        keys(node, ['kind', 'value']);
        demand(typeof node.value === 'string' || typeof node.value === 'boolean' || node.value === 1, 'literal'); break;
      case 'bool': keys(node, ['kind']); break;
      default: throw new Error('Unknown schema kind');
    }
    for (const ref of refs) visit(ref, [...path, name]);
  };
  for (const [name] of entries) {
    demand(/^[A-Z][A-Za-z0-9]*$/u.test(name), 'type name'); visit(name);
  }
  demand(JSON.stringify(input.types.Family.values) === JSON.stringify(Object.keys(causes)), 'single family taxonomy');
  demand(JSON.stringify(input.types.Code.values) === JSON.stringify(Object.values(causes).flat()), 'single cause taxonomy');
  for (const root of [...roots, 'Binding']) demand(Object.hasOwn(input.types, root), 'schema root');
}
function rustType(node) {
  if (node.kind === 'bool' || (node.kind === 'literal' && typeof node.value === 'boolean')) return 'bool';
  if (node.kind === 'number') return 'f64';
  // JSON 1 and 1.0 have the same version semantics; check_version still accepts only 1.
  if (node.kind === 'literal' && typeof node.value === 'number') return 'f64';
  if (node.kind === 'list') return `Vec<${node.item}>`;
  return 'String';
}
function rustDefinition(name, node) {
  const derive = '#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]\n';
  if (node.kind === 'record') return `${derive}#[serde(deny_unknown_fields)]\nstruct ${name} {\n${Object.entries(node.fields).map(([key, ref]) => `    #[serde(rename = ${quote(key)})] ${snake(key)}: ${ref},`).join('\n')}\n}\n`;
  if (node.kind === 'union') return `${derive}#[serde(tag = ${quote(node.tag)}, deny_unknown_fields)]\nenum ${name} {\n${Object.entries(node.variants).map(([tag, ref]) => `    #[serde(rename = ${quote(tag)})] ${variant(tag)}(Box<${ref}>),`).join('\n')}\n}\n`;
  if (node.kind === 'enum') return `${derive}enum ${name} {\n${node.values.map((tag) => `    #[serde(rename = ${quote(tag)})] ${variant(tag)},`).join('\n')}\n}\n`;
  return `type ${name} = ${rustType(node)};\n`;
}
function rustCheck(name, node) {
  let body;
  switch (node.kind) {
    case 'record': body = Object.entries(node.fields).map(([key, ref]) => `check_${snake(ref)}(&value.${snake(key)})?;`).join(' ') + ' Ok(())'; break;
    case 'union': body = `match value { ${Object.entries(node.variants).map(([tag, ref]) => `${name}::${variant(tag)}(inner) => check_${snake(ref)}(inner),`).join(' ')} }`; break;
    case 'list': body = `require(${node.min ? `value.len() >= ${node.min} && ` : ""}value.len() <= ${node.max})?; for item in value { check_${snake(node.item)}(item)?; } Ok(())`; break;
    case 'enum': case 'bool': body = 'let _ = value; Ok(())'; break;
    case 'literal': body = `require(${typeof node.value === 'string' ? 'value' : '*value'} == ${typeof node.value === 'number' ? node.value.toExponential() : quote(node.value)})`; break;
    case 'number': body = `require(value.is_finite() && *value > ${node.minExclusive.toExponential()} && *value <= ${node.max.toExponential()})`; break;
    case 'text': body = `text_format(value, ${quote(node.format)})`; break;
    default: throw new Error('Unknown schema kind');
  }
  if (name === 'Refusal') body = body.replace(' Ok(())', ' require(cause_family(&value.code) == value.family)?; unbound_refusal(value)');
  const borrowed = node.kind === 'list' ? `[${node.item}]` : rustType(node) === 'String' && !['record', 'union', 'enum'].includes(node.kind) ? 'str' : name;
  return `fn check_${snake(name)}(value: &${borrowed}) -> Result<(), &'static str> { let _ = value; ${body} }\n`;
}
function tsDefinition(name, node) {
  let body;
  switch (node.kind) {
    case 'record': body = `{ ${Object.entries(node.fields).map(([key, ref]) => `readonly ${key}: ${ref};`).join(' ')} }`; break;
    case 'union': body = Object.entries(node.variants).map(([tag, ref]) => `({ readonly ${node.tag}: ${quote(tag)} } & ${ref})`).join(' | '); break;
    case 'enum': body = node.values.map(quote).join(' | '); break;
    case 'list': body = `ReadonlyArray<${node.item}>`; break;
    case 'literal': body = quote(node.value); break;
    case 'number': body = 'number'; break;
    case 'bool': body = 'boolean'; break;
    case 'text': body = 'string'; break;
    default: throw new Error('Unknown schema kind');
  }
  return `export type ${name} = ${body};\n`;
}
export async function projections(input = schema) {
  validateSchema(input);
  const fingerprint = createHash('sha256').update(JSON.stringify({ schema: input, causes })).digest('hex');
  const header = `// SPDX-License-Identifier: MPL-2.0\n// @generated by scripts/retained-contract/generate.mjs; schema SHA256 ${fingerprint}\n// Private descriptive data only. No geometry, removal or publication authority.\n`;
  const entries = Object.entries(input.types);
  const semantics = await readFile(resolve(directory, 'rust-semantics.txt'), 'utf8');
  const rust = header + entries.map(([n, t]) => rustDefinition(n, t)).join('') + '\n'
    + entries.map(([n, t]) => rustCheck(n, t)).join('')
    + `fn cause_family(code: &Code) -> Family { match code { ${Object.entries(causes).flatMap(([family, codes]) => codes.map((code) => `Code::${variant(code)} => Family::${variant(family)},`)).join(' ')} } }\n`
    + '\n' + semantics;
  const rustTests = await readFile(resolve(directory, 'rust-tests.txt'), 'utf8');
  const outputs = new Map();
  for (const crate of ['geometry', 'processing']) {
    outputs.set(`rust/${crate}/src/generated/retained_contract.rs`, rust + '\n#[cfg(test)]\n#[path = "retained_contract_tests.rs"]\nmod tests;\n');
    outputs.set(`rust/${crate}/src/generated/retained_contract_tests.rs`, header + rustTests
      + `\nconst CASES: &str = r###"${JSON.stringify(cases)}"###;\n`);
  }
  outputs.set('scripts/retained-contract/generated/contract.ts', header
    + "import { validate } from '../validate.mjs';\n" + entries.map(([n, t]) => tsDefinition(n, t)).join('')
    + roots.map((name) => `export function parse${name}(input: unknown${['ModelReport', 'InspectionReport'].includes(name) ? ', binding: Binding' : ''}): ${name} { return validate(${quote(name)}, input${['ModelReport', 'InspectionReport'].includes(name) ? ', binding' : ''}); }\n`).join(''));
  outputs.set('scripts/retained-contract/validate.d.mts', header
    + `import type { ${[...roots, 'Binding'].join(', ')} } from './generated/contract.js';\n`
    + `type Roots = { ${roots.map((name) => `${name}: ${name}`).join('; ')} };\n`
    + 'export function validate<K extends keyof Roots>(root: K, input: unknown, binding?: Binding): Roots[K];\n');
  return outputs;
}
export async function drift(root, outputs) {
  const failures = [];
  for (const [path, expected] of outputs) {
    try { if (await readFile(resolve(root, path), 'utf8') !== expected) failures.push(path); }
    catch (error) { if (error.code === 'ENOENT') failures.push(path); else throw error; }
  }
  return failures;
}
export async function writeOutputs(root, outputs) {
  for (const [path, data] of outputs) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), data);
  }
}
if (isMainEntry(import.meta.url)) {
  demand(process.argv.slice(2).every((arg) => arg === '--check'), 'generator argument');
  const outputs = await projections();
  if (process.argv.includes('--check')) {
    const failures = await drift(repo, outputs);
    demand(failures.length === 0, `generated drift: ${failures.join(', ')}`);
    console.log(`Retained contract v${schema.version}: ${outputs.size} projections match`);
  } else {
    await writeOutputs(repo, outputs);
    console.log(`Retained contract v${schema.version}: wrote ${outputs.size} projections`);
  }
}
