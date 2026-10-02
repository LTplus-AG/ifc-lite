/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. */
import { readFile } from 'node:fs/promises';
import { readSemanticFile } from './semantic-file.js';
import { createSemanticRelayServer, type RelayProvider } from '@ifc-lite/semantic/server';
interface RelayFile { allowedOrigins: string[]; clientTokenEnv: string; providers: Record<string, Omit<RelayProvider, 'bearerToken'> & { bearerEnv?: string }> }
function environment(name: unknown): string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Relay credentials require an environment variable name');
  const value = process.env[name]; if (!value) throw new Error('Relay credential environment variable is not set'); return value;
}
export async function semanticServe(options: ReadonlyMap<string, string>): Promise<void> {
  const path = options.get('--config'); const cert = options.get('--cert'); const key = options.get('--key');
  if (!path || !cert || !key) throw new Error('Serve requires --config F --cert F --key F');
  const data: unknown = JSON.parse(await readSemanticFile(path, 256000));
  if (!data || typeof data !== 'object' || !('providers' in data) || !('allowedOrigins' in data) || !('clientTokenEnv' in data)) throw new Error('Invalid relay configuration');
  if (Object.keys(data).some(key => !['clientTokenEnv', 'allowedOrigins', 'providers'].includes(key))) throw new Error('Relay configuration accepts credential environment references only');
  const config = data as RelayFile;
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.every(value => typeof value === 'string')
    || !config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)) throw new Error('Invalid relay configuration');
  const providers: Record<string, RelayProvider> = {};
  for (const [id, provider] of Object.entries(config.providers)) {
    if (!provider || typeof provider !== 'object' || typeof provider.endpoint !== 'string' || typeof provider.grantedHost !== 'string'
      || (provider.kind !== 'json' && provider.kind !== 'sparql')) throw new Error('Invalid relay provider');
    if (Object.keys(provider).some(key => !['endpoint', 'grantedHost', 'kind', 'bearerEnv'].includes(key))) throw new Error('Only credential environment references may appear in provider configuration');
    const env = provider.bearerEnv;
    if (env !== undefined) environment(env);
    Object.defineProperty(providers, id, { enumerable: true, value: { endpoint: provider.endpoint, grantedHost: provider.grantedHost,
      kind: provider.kind, bearerToken: env ? () => environment(env) : undefined } });
  }
  const port = Number(options.get('--port') ?? '8443');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay port');
  const server = createSemanticRelayServer({ providers, clientToken: environment(config.clientTokenEnv), allowedOrigins: config.allowedOrigins },
    { cert: await readFile(cert), key: await readFile(key) });
  server.on('error', () => { process.stderr.write('Semantic relay server failed\n'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => process.stderr.write(`Semantic relay listening on https://localhost:${port}\n`));
}
