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
