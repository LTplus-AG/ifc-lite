/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading the user-entered Dalux base URL (#2792).
 *
 * Its own module rather than sitting in `provider.ts`, which the node support
 * pushed from 398 to 442 lines and so past this repo's ~400-line limit.
 */

/** `node1`, `node2`, ... Mirrors the relay's own allowlist. */
const DALUX_NODE_PATTERN = /^node[1-9][0-9]{0,2}$/;

/**
 * Read a user-entered Dalux base URL and return just the node name.
 *
 * Dalux assigns each customer a node and prints the base URL beside the API
 * key, so users paste the whole thing. Only the node name is kept, and only if
 * it is a real Dalux field node: everything else about the URL is ours to
 * decide: `/api/dalux` is unauthenticated and publicly reachable, so any host
 * the relay can be aimed at becomes reachable by anyone through our egress
 * IPs. Keeping the origin ours to build bounds that to Dalux.
 *
 * Returns undefined for blank input or the default node, so the common case
 * sends no parameter at all. Throws on input that looks like a deliberate
 * attempt to reach somewhere else, because silently falling back to node1
 * would present as "my key does not work" rather than "that URL is wrong".
 */
export function parseDaluxNode(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return undefined;

  let host: string;
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new Error(`Not a valid Dalux base URL: ${trimmed}`);
  }

  const match = /^(node[1-9][0-9]{0,2})\.field\.dalux\.com$/.exec(host);
  if (!match || !DALUX_NODE_PATTERN.test(match[1])) {
    throw new Error(
      `Not a Dalux node URL: ${trimmed}. Expected something like https://node2.field.dalux.com/service/api`,
    );
  }
  return match[1] === 'node1' ? undefined : match[1];
}

/** Matches a Dalux field-node hostname exactly, e.g. `node2.field.dalux.com`. */
const DALUX_NODE_HOST_PATTERN = /^(node[1-9][0-9]{0,2})\.field\.dalux\.com$/;

/**
 * Returns the node name if `hostname` is a Dalux field node, or `undefined`
 * otherwise.
 *
 * Unlike {@link parseDaluxNode} this never throws: it is used to
 * opportunistically recognise a Dalux-shaped URL the API itself handed back
 * (a `downloadLink`), not to validate user input, so an unrecognised host is
 * simply "not a Dalux field node" rather than an error.
 */
export function daluxFieldNode(hostname: string): string | undefined {
  return DALUX_NODE_HOST_PATTERN.exec(hostname)?.[1];
}

/**
 * Reroutes a `rawUrl` on a *different* Dalux field node than `baseUrl` back
 * onto `baseUrl`'s origin, stamping that node as `daluxNode` — or
 * `undefined` if `rawUrl` isn't field-node-shaped.
 *
 * A `downloadLink`/revision-content value from a non-node1 account points
 * straight at that node using our own `/service/api` shape — not always the
 * opaque, differently-hosted link `BrowserDaluxApiClient.nodeSelectorFor`
 * describes. Untouched it never matches the relay's upstream, so the
 * browser fetches Dalux directly and CORS blocks it (#3308). The node comes
 * from `rawUrl` itself, which is authoritative; re-serialising is safe
 * because the relay rebuilds the request from the forwarded path/query
 * regardless of `rawUrl`'s exact bytes.
 */
export function canonicalFieldNodeUrl(rawUrl: string, baseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const base = new URL(baseUrl);
  if (parsed.origin === base.origin) return undefined; // caller's own-origin path
  // Boundary-checked, not a bare `startsWith`: with a base path of
  // `/service/api`, a bare prefix test also admits the SIBLING path
  // `/service/api-v2/...`, which is a different API surface and would be
  // rerouted through the relay as if it were ours. Match the path exactly, or
  // at a `/` boundary.
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  if (parsed.pathname !== basePath && !parsed.pathname.startsWith(`${basePath}/`)) return undefined;
  const node = daluxFieldNode(parsed.hostname);
  if (!node) return undefined;
  parsed.protocol = base.protocol;
  parsed.host = base.host;
  parsed.searchParams.set('daluxNode', node);
  return parsed.toString();
}
