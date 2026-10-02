/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Original demonstration assets and a localhost HTTPS SELECT endpoint. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { Store } from 'oxigraph';
import { pilotDocument, pilotModel, PILOT_QUERY } from '../src/lib/semantic/demo.js';
import { DEFAULT_PROFILE, profileContext, profileToDictionary, exchangeSchema, shapesTurtle, vocabularyTurtle,
  asJsonLd, toRdf, assertReadOnlyQuery, recordsFromGraph } from '@ifc-lite/semantic';

const [command, ...args] = process.argv.slice(2);
const document = pilotDocument();
const genericGraph = `@prefix ex: <https://example.org/charter-6643/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:building a ex:Asset ; ex:label "Building"@en, "Gebäude"@de ; ex:logbook ex:logbook .
ex:logbook a ex:Logbook ; ex:inspection _:inspection ; ex:product ex:product .
_:inspection ex:temperature "20.5"^^xsd:decimal ; ex:date "2026-10-01"^^xsd:date ; ex:passed true .
ex:product a ex:Product ; ex:identifier "GTIN 09506000134352" ; ex:passport <did:example:passport> .
<did:example:passport> ex:declaration "Synthetic declaration" ; ex:related ex:product .
`;
const genericQuery = 'SELECT ?subject ?predicate ?object WHERE { ?subject ?predicate ?object } LIMIT 5000';
const constructQuery = 'CONSTRUCT { ?subject ?predicate ?object } WHERE { ?subject ?predicate ?object } LIMIT 5000';
// Original bounded data for exercising the shared row budget in a real browser.
const largeGraph = Array.from({ length: 5000 }, (_, index) =>
  `<https://example.org/charter-6643/item/${index}> <https://example.org/charter-6643/label> "Synthetic item ${index}" .`,
).join('\n');
const rdf = await toRdf(document);
if (command === '--serve') {
  const [certificate, key, portText = '8443'] = args;
  if (!certificate || !key) throw new Error('Usage: --serve <trusted certificate.pem> <key.pem> [port]');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const graph = new Store(); graph.load(rdf, { format: 'application/n-quads' });
  const generic = new Store(); generic.load(genericGraph, { format: 'text/turtle' });
  const large = new Store(); large.load(largeGraph, { format: 'text/turtle' });
  const server = createServer({ cert: await readFile(certificate), key: await readFile(key) }, async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    try {
      if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
      if (request.method === 'GET' && request.url === '/records') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(document)); return;
      }
      if (request.method === 'POST' && ['/sparql', '/generic', '/large'].includes(request.url ?? '')) {
        let body = ''; for await (const chunk of request) {
          body += String(chunk); if (body.length > 256000) throw new Error('Request exceeds the pilot limit');
        }
        const query = new URLSearchParams(body).get('query');
        if (!query) throw new Error('Missing query'); const kind = assertReadOnlyQuery(query);
        const format = kind === 'select' ? 'application/sparql-results+json' : 'text/turtle';
        response.setHeader('Content-Type', format);
        const store = request.url === '/generic' ? generic : request.url === '/large' ? large : graph;
        response.end(String(store.query(query, { results_format: format }))); return;
      }
      response.writeHead(404).end('Unknown pilot endpoint');
    } catch (error) { response.writeHead(400).end(error instanceof Error ? error.message : String(error)); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`Original pilot: https://localhost:${port}/records and /sparql and /generic and /large`));
} else {
  const output = command ?? '/tmp/ifc-lite-semantic-pilot';
  await mkdir(output, { recursive: true });
  const files: Record<string, string> = {
    'records.json': JSON.stringify(document, null, 2),
    'records-valid.json': JSON.stringify({ ...document, resources: document.resources.filter(record => !record.id.endsWith('incomplete-passport')) }, null, 2),
    'schema.json': JSON.stringify(exchangeSchema(), null, 2), 'context.json': JSON.stringify({ '@context': profileContext() }, null, 2),
    'records.jsonld': JSON.stringify(asJsonLd(document), null, 2), 'records.nq': rdf,
    'shapes.ttl': await shapesTurtle(), 'vocabulary.ttl': await vocabularyTurtle(),
    'profile.json': JSON.stringify(DEFAULT_PROFILE, null, 2), 'generic.ttl': genericGraph,
    'generic-query.rq': genericQuery, 'construct-query.rq': constructQuery,
    'generic.json': JSON.stringify({ id: 'https://example.org/charter-6643/generic', source: 'https://example.org/charter-6643/',
      completeness: 'complete', resources: recordsFromGraph(genericGraph), graph: genericGraph, graphFormat: 'text/turtle' }, null, 2),
    'dictionary.json': JSON.stringify(profileToDictionary(), null, 2), 'query.rq': PILOT_QUERY,
    'revision-1.ifc': pilotModel(0).content, 'revision-2.ifc': pilotModel(1).content,
  };
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(output, name), content)));
  console.log(`Wrote ${Object.keys(files).length} original pilot files to ${output}`);
}
