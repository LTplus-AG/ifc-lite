/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Native clash findings and a stubbed streaming proxy provider for full-run classification tests (#6906). */

import type { Clash } from '@ifc-lite/clash';

export function clashFindings(count: number): Clash[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `f-${i}`, rule: 'coordination', status: 'hard', severity: i % 2 ? 'minor' : 'major', distance: -0.01,
    a: { key: `A${i}`, ref: i + 1, model: 'arch', tag: 'IfcWall' }, b: { key: `B${i}`, ref: 10_000 + i, model: 'mep', tag: 'IfcPipeSegment' },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  }));
}

/** Chunk-specific spellings of the same two groups, so the merge has to fold names. */
const SPELLINGS = [['Major walls/pipes', 'Minor walls/pipes'], ['major walls/pipes', 'Minor walls/pipes'], ['Major  Walls/Pipes', 'MINOR walls/pipes']];

/**
 * A stubbed proxy provider. It reads the chunk's frozen rows from the request,
 * groups them by native severity and leaves every tenth row (always a minor one) uncited.
 */
export function serveClassifier(options: { repeatInChunk?: number; hangOnChunk?: number } = {}) {
  const requests: Array<{ chunk: number; citations: string[] }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const content = body.messages.at(-1)!.content;
    const chunk = Number(/chunk (\d+) of/.exec(content)![1]);
    const rows = JSON.parse(content.slice(content.indexOf('{'))).evidence.rows as Array<{ citation: string; data: { severity: string } }>;
    requests.push({ chunk, citations: rows.map(row => row.citation) });
    if (options.hangOnChunk === chunk) {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    }
    const cited = rows.filter((_row, index) => index % 10 !== 9);
    const [major, minor] = SPELLINGS[(chunk - 1) % SPELLINGS.length];
    const groups = [
      { name: major, explanation: `Major findings in chunk ${chunk}`, citations: cited.filter(row => row.data.severity === 'major').map(row => row.citation) },
      { name: minor, explanation: `Minor findings in chunk ${chunk}`, citations: cited.filter(row => row.data.severity === 'minor').map(row => row.citation) },
    ];
    if (options.repeatInChunk === chunk) groups[1].citations.push(groups[0].citations[0]);
    const text = JSON.stringify({ version: 1, kind: 'clash.groups', groups });
    const frame = { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(frame)}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return requests;
}
