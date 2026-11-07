/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure helpers for the retained-only hosted preview (#7955): which staged engine
// files are served where, the static host configuration (`vercel.json`), its
// header/rewrite semantics for the local rehearsal server, and the notice checks
// shared by the builder and the URL smoke. No I/O here; the scripts own it.

/** URL prefixes of the driver contract (docs/guide/retained-installation.md). */
export const SMLIB_PREFIX = '/smlib/';
export const ENGINE_PREFIX = '/retained-engine/';

/** Same selection as apps/viewer/vite-plugins/retained-engine.ts serves under /retained-engine/. */
const ENGINE_ROOT_FILE = /^(pkg-retained\/|LICENSES\/|engine-manifest\.json$|THIRD_PARTY_NOTICES\.txt$)/;

/** Notice texts a distribution of the engine must serve beside it. */
export const REQUIRED_NOTICES = [
  'smlib/LICENSE',
  'smlib/THIRD_PARTY_NOTICES.md',
  'smlib/IFC_LITE_LICENSE.txt',
  'smlib/IFC_LITE_THIRD_PARTY_NOTICES.txt',
  'THIRD_PARTY_NOTICES.txt',
  'LICENSES/ifc-lite/LICENSE',
  'LICENSES/SMLib/LICENSE',
  'LICENSES/SMLib/THIRD_PARTY_NOTICES.md',
  'pkg-retained/IFC_LITE_LICENSE.txt',
  'pkg-retained/THIRD_PARTY_NOTICES.txt',
];

/** IFC-Lite's combined notices: the ones that carry the covered-source URL. */
export const SOURCE_URL_NOTICES = [
  'smlib/IFC_LITE_THIRD_PARTY_NOTICES.txt',
  'THIRD_PARTY_NOTICES.txt',
  'pkg-retained/THIRD_PARTY_NOTICES.txt',
];

export const SOURCE_URL_BASE = 'https://github.com/LTplus-AG/ifc-lite/tree/';
export const PLACEHOLDER = `${SOURCE_URL_BASE}<tag>`;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * Map engine-manifest asset paths to their served URL paths. Everything under
 * smlib/ is served at /smlib/; root files the dev middleware allows at
 * /retained-engine/. Reject unsupported paths so no manifest entry is omitted.
 */
export function servedEngineFiles(manifestAssets) {
  const files = [{ source: 'engine-manifest.json', url: `${ENGINE_PREFIX}engine-manifest.json` }];
  for (const { path } of manifestAssets) {
    if (typeof path !== 'string' || path.includes('\\') || path.split('/').some(p => p === '' || p === '.' || p === '..')) {
      throw new Error(`Unsafe engine asset path ${JSON.stringify(path)}`);
    }
    if (path.startsWith('smlib/')) files.push({ source: path, url: `/${path}` });
    else if (ENGINE_ROOT_FILE.test(path)) files.push({ source: path, url: `${ENGINE_PREFIX}${path}` });
    else throw new Error(`Unsupported engine asset path ${JSON.stringify(path)}`);
  }
  return files;
}

/** Problems with the notice set in a manifest's asset list (empty = complete). */
export function missingNotices(manifestAssets) {
  const present = new Set(manifestAssets.map(({ path }) => path));
  return REQUIRED_NOTICES.filter(path => !present.has(path));
}

/**
 * Source-URL check for one IFC-Lite notice text. With a tag: the exact release
 * URL must be present and the placeholder absent. Without: report the state.
 */
export function noticeSourceProblems(text, sourceTag) {
  const problems = [];
  if (sourceTag !== undefined) {
    if (!RELEASE_TAG.test(sourceTag)) return [`source tag ${JSON.stringify(sourceTag)} is not a root v<major>.<minor>.<patch> tag`];
    if (!text.match(/https:\/\/github\.com\/LTplus-AG\/ifc-lite\/tree\/[^\s<>"'()]+/g)?.some(url => url.replace(/[.,;:]+$/, '') === `${SOURCE_URL_BASE}${sourceTag}`)) problems.push(`no covered-source URL ${SOURCE_URL_BASE}${sourceTag}`);
  }
  if (text.includes('<tag>')) problems.push('covered-source URL still has the <tag> placeholder');
  return problems;
}

/** Replace the placeholder in a notice template with the release tag. */
export function fillSourceTag(text, sourceTag) {
  if (!RELEASE_TAG.test(sourceTag)) throw new Error(`source tag ${JSON.stringify(sourceTag)} is not a root v<major>.<minor>.<patch> tag`);
  if (!text.includes(PLACEHOLDER)) throw new Error('notice template has no covered-source placeholder');
  return text.replaceAll('<tag>', sourceTag);
}

const ISOLATION = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
];

/**
 * Static host configuration for the preview. Vercel applies every matching
 * header rule in order (later wins for the same key); rewrites run only when
 * no file matches. The SPA fallback excludes the engine prefixes, so a missing
 * Worker, WASM or licence path is a 404, never index.html. `true` as build and
 * install command: the upload is already built; nothing may build on the host.
 * `ignoreCommand: exit 1` overrides the projects' dashboard Ignored Build Step,
 * which cancels every non-production remote build.
 */
export function previewHostConfig() {
  const js = 'text/javascript; charset=utf-8', text = 'text/plain; charset=utf-8';
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    installCommand: 'true',
    buildCommand: 'true',
    ignoreCommand: 'exit 1',
    outputDirectory: 'public',
    cleanUrls: false,
    trailingSlash: false,
    rewrites: [{ source: '/((?!smlib/|retained-engine/)(?!.*\\.).*)', destination: '/index.html' }],
    headers: [
      { source: '/(.*)', headers: [...ISOLATION, { key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
      { source: '/(.*)\\.wasm', headers: [{ key: 'Content-Type', value: 'application/wasm' }] },
      { source: '/(.*)\\.(js|mjs)', headers: [{ key: 'Content-Type', value: js }] },
      { source: '/(.*)\\.json', headers: [{ key: 'Content-Type', value: 'application/json' }] },
      { source: '/(.*)\\.(md|txt)', headers: [{ key: 'Content-Type', value: text }] },
      { source: '/retained-engine/LICENSES/(.*)', headers: [{ key: 'Content-Type', value: text }] },
      { source: '/smlib/LICENSE', headers: [{ key: 'Content-Type', value: text }] },
      { source: '/(smlib|retained-engine)/(.*)', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      { source: '/', headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }] },
    ],
  };
}

/** Our generated sources use regex groups only (no `:name` params), so ^source$ is exact. */
function sourceRegex(source) {
  if (/:[A-Za-z]/.test(source)) throw new Error(`named parameters are not emulated: ${source}`);
  return new RegExp(`^${source}$`);
}

/** Headers the host config assigns to a URL path (later rules override earlier keys). */
export function headersFor(config, pathname) {
  const out = new Map();
  for (const rule of config.headers) {
    if (!sourceRegex(rule.source).test(pathname)) continue;
    for (const { key, value } of rule.headers) out.set(key.toLowerCase(), { key, value });
  }
  return Object.fromEntries([...out.values()].map(({ key, value }) => [key, value]));
}

/** The rewrite destination for a path with no matching file, or null for a 404. */
export function rewriteFor(config, pathname) {
  for (const rule of config.rewrites) if (sourceRegex(rule.source).test(pathname)) return rule.destination;
  return null;
}

/** Response-header expectations for one engine URL (shared by local and hosted checks). */
export function responseProblems({ url, status, headers, expectType }) {
  const problems = [];
  const get = name => headers[name.toLowerCase()] ?? null;
  if (status !== 200) problems.push(`${url}: HTTP ${status}`);
  for (const { key, value } of ISOLATION) if (get(key) !== value) problems.push(`${url}: ${key}=${get(key)}`);
  const type = get('content-type') ?? '';
  if (expectType && !expectType.test(type)) problems.push(`${url}: content-type ${type}`);
  return problems;
}

/** Expected content type per served path. */
export function expectedType(url) {
  if (url.endsWith('.wasm')) return /^application\/wasm\b/;
  if (/\.(m?js)$/.test(url)) return /^(text|application)\/javascript\b/;
  if (url.endsWith('.json')) return /^application\/json\b/;
  return /^text\/plain\b/;
}

/** Bind the served engine to both preview identity and any explicit caller pin. */
export function assertManifestIdentity(identity, servedHash, expectedHash) {
  if (!identity || identity.engineManifestSha256 !== servedHash) {
    throw new Error(`served engine manifest ${servedHash} differs from preview identity`);
  }
  if (expectedHash && servedHash !== expectedHash) {
    throw new Error(`served engine manifest ${servedHash} != expected ${expectedHash}`);
  }
}
