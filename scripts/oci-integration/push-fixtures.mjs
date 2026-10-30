/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Push IFC fixtures to a loopback registry with ORAS, then prove what landed.
 *
 *   node scripts/oci-integration/push-fixtures.mjs --registry 127.0.0.1:<port> \
 *     [--user <name>] [--repository fixtures/model] --tag v1=<file.ifc> --tag v2=<file.ifc>
 *
 * The password comes from OCI_REGISTRY_PASSWORD and reaches ORAS on stdin
 * (`--password-stdin`), so it is never on argv and never written to a docker
 * credential store. Each push is plain HTTP (loopback zot has no TLS):
 *
 *   artifactType  application/vnd.ifc-lite.test.v1
 *   one layer     application/x-step, annotated
 *                 org.opencontainers.image.title=<file basename>
 *
 * ORAS derives the title annotation from the path it is given, so it runs in
 * the file's directory with the bare basename (an absolute path would be
 * refused by its path validation, and a relative one would leak into the
 * title).
 *
 * A push that exits 0 proves only that ORAS was satisfied. Afterwards each
 * manifest is fetched back and checked: artifact type, exactly one layer, its
 * media type, its title, and that its digest and size are the local file's.
 * Any mismatch fails the step, so a later `ifc-lite` failure cannot be blamed
 * on a fixture that was never there.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const ARTIFACT_TYPE = 'application/vnd.ifc-lite.test.v1';
const LAYER_MEDIA_TYPE = 'application/x-step';
const TITLE = 'org.opencontainers.image.title';

function fail(message) {
  process.stderr.write(`push-fixtures: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { registry: undefined, user: 'ifclite-ci', repository: 'fixtures/model', tags: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) fail(`missing value for ${flag}`);
    i += 1;
    if (flag === '--registry') options.registry = value;
    else if (flag === '--user') options.user = value;
    else if (flag === '--repository') options.repository = value;
    else if (flag === '--tag') {
      const eq = value.indexOf('=');
      if (eq <= 0) fail(`--tag expects <tag>=<file>, got ${value}`);
      options.tags.push({ tag: value.slice(0, eq), file: resolve(value.slice(eq + 1)) });
    } else fail(`unknown argument: ${flag}`);
  }
  if (!options.registry) fail('--registry <host:port> is required');
  if (options.tags.length === 0) fail('at least one --tag <tag>=<file> is required');
  return options;
}

function oras(args, { cwd, password }) {
  const result = spawnSync('oras', args, { cwd, input: `${password}\n`, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') fail('oras not found on PATH (run .github/actions/setup-oci-registries)');
  if (result.status !== 0) {
    fail(`oras ${args[0]} ${args[1] ?? ''} exited ${result.status}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

const options = parseArgs(process.argv.slice(2));
const password = process.env.OCI_REGISTRY_PASSWORD;
if (!password) fail('OCI_REGISTRY_PASSWORD must be set');
const auth = ['--plain-http', '--username', options.user, '--password-stdin'];

for (const { tag, file } of options.tags) {
  const name = basename(file);
  const bytes = readFileSync(file);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const reference = `${options.registry}/${options.repository}:${tag}`;
  process.stdout.write(oras(
    ['push', ...auth, '--artifact-type', ARTIFACT_TYPE, reference, `${name}:${LAYER_MEDIA_TYPE}`],
    { cwd: dirname(file), password },
  ));

  const manifest = JSON.parse(oras(['manifest', 'fetch', ...auth, reference], { password }));
  const problems = [];
  if (manifest.artifactType !== ARTIFACT_TYPE) problems.push(`artifactType ${manifest.artifactType}`);
  const layers = manifest.layers ?? [];
  if (layers.length !== 1) problems.push(`${layers.length} layers`);
  const [layer = {}] = layers;
  if (layer.mediaType !== LAYER_MEDIA_TYPE) problems.push(`layer mediaType ${layer.mediaType}`);
  if (layer.annotations?.[TITLE] !== name) problems.push(`title ${layer.annotations?.[TITLE]}`);
  if (layer.digest !== digest) problems.push(`layer digest ${layer.digest}, file is ${digest}`);
  if (layer.size !== statSync(file).size) problems.push(`layer size ${layer.size}, file is ${statSync(file).size}`);
  if (problems.length > 0) fail(`${reference} does not hold ${name}: ${problems.join('; ')}`);
  console.log(`verified ${reference}: ${name} ${digest} (${layer.size} bytes)`);
}
