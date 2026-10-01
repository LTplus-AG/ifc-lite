/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. */
/** Headless entry for the same semantic provider and validators used by the viewer. */
import { readSemanticFile as readBounded } from './semantic-file.js';
import { writeOutput } from '../output.js';
import {
  DEFAULT_PROFILE, assertProfile, assertReadOnlyQuery, createSemanticProvider,
  generateArtifacts, parseGraph, createValidationReport, parseImport, validateJson, validateLinks, validateGraph,
  type ProfileDefinition,
} from '@ifc-lite/semantic';

const VALUE_FLAGS = new Set(['--profile', '--endpoint', '--host', '--query', '--kind', '--bearer-env', '--artifact', '--out', '--shapes', '--relay-provider', '--config', '--cert', '--key', '--port', '--graph-format']);
const SWITCH_FLAGS = new Set(['--json', '--rdf', '--graph-format']);
interface ParsedArgs { action: string; input?: string; options: Map<string, string>; json: boolean; rdf: boolean }
function parseArgs(args: string[]): ParsedArgs {
  const [action, ...rest] = args; const options = new Map<string, string>(); const positional: string[] = [];
  const switches = new Set<string>();
  if (!['validate', 'query', 'assets', 'serve'].includes(action)) throw new Error('Usage: ifc-lite semantic <validate|query|assets|serve> [options]');
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (VALUE_FLAGS.has(arg)) {
      if (options.has(arg) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Supply exactly one value for ${arg}`);
      options.set(arg, rest[++i]);
    } else if (SWITCH_FLAGS.has(arg)) { if (switches.has(arg)) throw new Error(`Duplicate option: ${arg}`); switches.add(arg); }
    else if (arg.startsWith('-')) throw new Error(`Unknown semantic option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1 || (action === 'validate' ? !positional.length : positional.length)) throw new Error('Only validate accepts one input filename');
  const allowed = action === 'serve' ? ['--config', '--cert', '--key', '--port'] : action === 'validate' ? ['--profile', '--shapes', '--out', '--json', '--rdf', '--graph-format']
    : action === 'assets' ? ['--profile', '--artifact', '--out', '--json']
      : ['--endpoint', '--host', '--query', '--kind', '--bearer-env', '--relay-provider', '--out', '--json'];
  for (const key of [...options.keys(), ...switches]) if (!allowed.includes(key)) throw new Error(`Option ${key} does not apply to ${action}`);
  return { action, input: positional[0], options, json: switches.has('--json'), rdf: switches.has('--rdf') };
}

async function profileFrom(path?: string): Promise<ProfileDefinition> {
  if (!path) return DEFAULT_PROFILE;
  const profile: unknown = JSON.parse(await readBounded(path));
  if (!profile || typeof profile !== 'object' || !('types' in profile) || !('fields' in profile)) throw new Error('Expected a technology-neutral profile');
  const definition = profile as ProfileDefinition; assertProfile(definition); return definition;
}
/** Exported only for command behavior tests; process output is reserved for its standard payload. */
export async function semanticCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args); const option = (key: string) => parsed.options.get(key);
  if (parsed.action === 'serve') { await (await import('./semantic-serve.js')).semanticServe(parsed.options); return; }
  if (parsed.action === 'assets') {
    const profile = await profileFrom(option('--profile'));
    const artifacts = await generateArtifacts(profile);
    const name = option('--artifact') ?? 'schema';
    if (!['schema', 'context', 'shapes', 'vocabulary', 'profile'].includes(name)) throw new Error('Artifact must be schema, context, shapes, vocabulary, or profile');
    const value: unknown = name === 'profile' ? profile : artifacts[name as keyof typeof artifacts];
    await writeOutput(typeof value === 'string' && !parsed.json ? value : JSON.stringify(value, null, 2), option('--out'));
    return;
  }
  if (parsed.action === 'validate') {
    const profile = await profileFrom(option('--profile')); const content = await readBounded(parsed.input!);
    const rdf = parsed.rdf || /\.(ttl|nt|nq|jsonld)$/i.test(parsed.input!);
    const shapes = option('--shapes') ? await readBounded(option('--shapes')!) : undefined;
    if ((shapes || option('--graph-format')) && !rdf) throw new Error('--shapes and --graph-format apply to RDF inputs');
    let report;
    if (rdf) {
      const format = option('--graph-format') ?? (/\.(nt|nq)$/i.test(parsed.input!) ? 'nquads' : /\.jsonld$/i.test(parsed.input!) ? 'jsonld' : 'turtle');
      if (!['turtle', 'nquads', 'jsonld'].includes(format)) throw new Error('Graph format must be turtle, nquads, or jsonld');
      const graph = await parseGraph(content, { format: format === 'turtle' ? 'text/turtle' : format === 'nquads' ? 'application/n-quads' : 'application/ld+json' });
      report = createValidationReport({ profile, scope: 'graph', completeness: 'partial', engines: ['SHACL'],
        findings: await validateGraph(graph.graph, { profile, shapes }) });
    } else {
      const document = parseImport(JSON.parse(content) as unknown, profile);
      report = createValidationReport({ profile, scope: 'profile', completeness: document.completeness, source: document.source,
        engines: ['JSON Schema', 'links'], findings: [...validateJson(document, profile), ...validateLinks(document, profile)] });
    }
    await writeOutput(parsed.json ? JSON.stringify(report, null, 2)
      : `${report.conforms ? 'Conforms' : 'Does not conform'} to ${profile.id}\n${report.findings.map(f => `${f.engine}: ${f.resourceId} ${f.path} ${f.message}`).join('\n')}`, option('--out'));
    if (!report.conforms) process.exitCode = 1;
    return;
  }
  const endpoint = option('--endpoint'); const host = option('--host');
  if (!endpoint || !host) throw new Error('Query requires --endpoint <https-url> --host <explicit-hostname>');
  const query = option('--query') ? await readBounded(option('--query')!, 256000) : undefined;
  const inferred = query === undefined ? 'json' : assertReadOnlyQuery(query);
  const kind = option('--kind') ?? inferred;
  if (!['json', 'select', 'construct'].includes(kind) || kind !== inferred) throw new Error('Query kind must match SELECT, CONSTRUCT, or JSON without a query');
  const envName = option('--bearer-env');
  if (envName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error('Invalid credential environment name');
  const bearer = envName ? process.env[envName] : undefined;
  if (envName && !bearer) throw new Error('Credential environment variable is not set');
  try {
    const result = await createSemanticProvider().read({ endpoint, host, kind: kind as 'json' | 'select' | 'construct', query,
      bearer, relayProvider: option('--relay-provider') });
    const value = result.kind === 'select' ? { head: { vars: result.value.columns }, results: { bindings: result.value.rows } } : result.value;
    const content = typeof value === 'string' && !parsed.json ? value : JSON.stringify(value, null, 2);
    await writeOutput(bearer ? content.replaceAll(bearer, '[REDACTED]') : content, option('--out'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(bearer ? message.replaceAll(bearer, '[REDACTED]') : message);
  }
}
