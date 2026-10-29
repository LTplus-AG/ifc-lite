/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure InfluxDB 2 adapters shared by the headless recipe and viewer (#8090).
 * No Flow execution, DOM, storage or environment access. */
import type { Row, Table } from '@ifc-lite/flow';
import { parseCsvText } from './csv-parse.js';
import { queryRequest, type InfluxSelection } from './influx-query.js';
import { dataTable, latestPerSeries } from './influx-table.js';
export { queryRequest, dataTable, latestPerSeries };
export type { InfluxSelection };

function influxTokenForms(token: string): string[] {
  return token ? [...new Set([token, encodeURIComponent(token)])] : [];
}

/** True when `value` carries the raw or URI-encoded token. Percent-escape hex
 * digits are case-insensitive, so `%2f` matches `%2F` as well. */
export function containsInfluxToken(value: string, token: string): boolean {
  if (!token) return false;
  if (value.includes(token)) return true;
  const encoded = encodeURIComponent(token);
  if (encoded !== token && value.toLowerCase().includes(encoded.toLowerCase())) return true;
  // Partially or noncanonically encoded forms (e.g. `secret%2Fa+b`) decode to the token.
  if (!value.includes('%')) return false;
  try { return decodeURIComponent(value).includes(token); } catch { return false; }
}

/** Share raw/URI-encoded redaction for every surfaced error. */
function redactInfluxText(message: string, token: string): string {
  for (const secret of influxTokenForms(token)) {
    message = message.split(secret).join('[REDACTED]');
  }
  // Same detection as containsInfluxToken: drop the whole message if any other encoding survives.
  return containsInfluxToken(message, token) ? 'InfluxDB request failed ([REDACTED])' : message;
}

export function redactInfluxError(error: unknown, token: string): string {
  return redactInfluxText(error instanceof Error ? error.message : 'InfluxDB request failed', token);
}

/** `token` is required so every caller states which credential must not be echoed back. */
export function parseInfluxCsv(csv: string, selection: InfluxSelection, token: string): { history: Table; latest: Table } {
  return parseInfluxResponse(csv, selection, token);
}

function parseInfluxResponse(csv: string, selection: InfluxSelection, token: string): { history: Table; latest: Table } {
  if (new TextEncoder().encode(csv).length > 2 * 1024 * 1024) throw new Error('InfluxDB response exceeds 2 MiB');
  const parsed = parseCsvText(csv, ',', true);
  const containsToken = (cell: string) => containsInfluxToken(cell, token);
  // Decode CSV escaping first, then reject before grouping can change identity.
  if (token && (parsed.header.some(containsToken) || parsed.rows.some(row => row.fields.some(containsToken)))) {
    throw new InfluxRequestError('data', redactInfluxText('InfluxDB response contains credentials', token));
  }
  if (parsed.rows.some(row => row.fieldCountMismatch)) throw new Error('Malformed or multi-table CSV response');
  const table: Table = {
    key: selection.guidTag,
    columns: parsed.header.map(name => ({ name, type: 'string' })),
    rows: parsed.rows.map(row => Object.fromEntries(parsed.header.map((name, i) => [name, row.fields[i]]))),
  };
  const history = dataTable(table);
  return { history, latest: latestPerSeries(history, selection) };
}

export class InfluxRequestError extends Error {
  constructor(readonly kind: 'config' | 'network' | 'http' | 'data', message: string) {
    super(message);
    this.name = 'InfluxRequestError';
  }
}

/** True when any selection value or tag (sent in the URL or Flux body) carries the token. */
export function selectionContainsToken(selection: InfluxSelection, token: string): boolean {
  const publicValues = [...Object.values(selection), ...Object.entries(selection.tags ?? {}).flat()];
  return publicValues.some(value => typeof value === 'string' && containsInfluxToken(value, token));
}

/** Request/response byte and time bounds supplement the server-side sample cap.
 * Never surface response bodies or transport exception messages (may echo auth). */
export async function fetchInfluxReadings(selection: InfluxSelection, token: string, transport: typeof fetch = fetch, signal?: AbortSignal) {
  let request: ReturnType<typeof queryRequest>;
  try {
    if (token.length < 6 || /[\r\n]/.test(token)) throw new Error('Enter a valid token');
    if (selectionContainsToken(selection, token)) throw new Error('Keep the token only in the password input');
    request = queryRequest(selection);
  } catch (error) {
    throw new InfluxRequestError('config', redactInfluxError(error, token));
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 15000);
  try {
    let response: Response;
    try {
      response = await transport(request.url, {
        method: 'POST', headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json', Accept: 'application/csv' },
        body: request.body, signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new InfluxRequestError('network', 'CORS or network error: the server must allow the viewer origin, or use a fixed-upstream gateway.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new InfluxRequestError('http', `InfluxDB query failed (HTTP ${response.status})`);
    }
    let csv = '';
    try {
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2 * 1024 * 1024) throw new Error('InfluxDB response exceeds 2 MiB');
            csv += decoder.decode(value, { stream: true });
          }
          csv += decoder.decode();
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      return parseInfluxResponse(csv, selection, token);
    } catch (error) {
      // Parser errors contain only fixed validation messages; transport stream
      // exceptions may contain anything, so do not publish their text.
      if (error instanceof InfluxRequestError) throw error;
      throw new InfluxRequestError('data', 'Invalid, truncated, oversized or nonnumeric InfluxDB response');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** Matching keeps model-space identity; duplicate GUIDs across models and
 * competing series are both ambiguous, never resolved to a first match. */
export function matchInfluxSeries<T extends { GlobalId: string }>(latest: Table, targets: readonly T[]) {
  const byGuid = new Map<string, T[]>();
  for (const target of targets) {
    const list = byGuid.get(target.GlobalId) ?? [];
    list.push(target);
    byGuid.set(target.GlobalId, list);
  }
  const counts = new Map<string, number>();
  for (const row of latest.rows) {
    const guid = String(row[latest.key]);
    counts.set(guid, (counts.get(guid) ?? 0) + 1);
  }
  const matched: Array<{ row: Row; target: T }> = [];
  const unmatched: Row[] = [], ambiguous: Row[] = [];
  for (const row of latest.rows) {
    const guid = String(row[latest.key]);
    const candidates = byGuid.get(guid) ?? [];
    if (!candidates.length) unmatched.push(row);
    else if (candidates.length !== 1 || counts.get(guid) !== 1) ambiguous.push(row);
    else matched.push({ row, target: candidates[0] });
  }
  return { matched, unmatched, ambiguous };
}
