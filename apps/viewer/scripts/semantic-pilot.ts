/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Original demonstration assets and a localhost HTTPS SELECT endpoint. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { Store } from 'oxigraph';
import { pilotDocument, pilotModel, PILOT_QUERY } from '../src/lib/semantic/demo.js';
import { context, dictionary, exchangeSchema, shapesTurtle, vocabularyTurtle } from '../src/lib/semantic/profile.js';
import { asJsonLd, toRdf } from '../src/lib/semantic/validation.js';
import { assertSelect } from '../src/lib/semantic/transport.js';

const [command, ...args] = process.argv.slice(2);
const document = pilotDocument();
const rdf = await toRdf(document);
if (command === '--serve') {
  const [certificate, key, portText = '8443'] = args;
  if (!certificate || !key) throw new Error('Usage: --serve <trusted certificate.pem> <key.pem> [port]');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const graph = new Store(); graph.load(rdf, { format: 'application/n-quads' });
  const server = createServer({ cert: await readFile(certificate), key: await readFile(key) }, async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    try {
      if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
      if (request.method === 'GET' && request.url === '/records') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(document)); return;
      }
      if (request.method === 'POST' && request.url === '/sparql') {
        let body = ''; for await (const chunk of request) {
          body += String(chunk); if (body.length > 256000) throw new Error('Request exceeds the pilot limit');
        }
        const query = new URLSearchParams(body).get('query');
        if (!query) throw new Error('Missing query'); assertSelect(query);
        response.setHeader('Content-Type', 'application/sparql-results+json');
        response.end(String(graph.query(query, { results_format: 'application/sparql-results+json' }))); return;
      }
      response.writeHead(404).end('Unknown pilot endpoint');
    } catch (error) { response.writeHead(400).end(error instanceof Error ? error.message : String(error)); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`Original pilot: https://localhost:${port}/records and /sparql`));
} else {
  const output = command ?? '/tmp/ifc-lite-semantic-pilot';
  await mkdir(output, { recursive: true });
  const files: Record<string, string> = {
    'records.json': JSON.stringify(document, null, 2),
    'records-valid.json': JSON.stringify({ ...document, resources: document.resources.filter(record => !record.id.endsWith('incomplete-passport')) }, null, 2),
    'schema.json': JSON.stringify(exchangeSchema, null, 2), 'context.json': JSON.stringify({ '@context': context }, null, 2),
    'records.jsonld': JSON.stringify(asJsonLd(document), null, 2), 'records.nq': rdf,
    'shapes.ttl': await shapesTurtle(), 'vocabulary.ttl': await vocabularyTurtle(),
    'dictionary.json': JSON.stringify(dictionary, null, 2), 'query.rq': PILOT_QUERY,
    'revision-1.ifc': pilotModel(0).content, 'revision-2.ifc': pilotModel(1).content,
  };
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(output, name), content)));
  console.log(`Wrote ${Object.keys(files).length} original pilot files to ${output}`);
}
