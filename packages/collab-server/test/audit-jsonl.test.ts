/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileAuditSink } from '../src/audit-log.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-audit-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('JsonlFileAuditSink', () => {
  it('appends one line per entry, parseable as NDJSON', async () => {
    const sink = new JsonlFileAuditSink({ filePath: path.join(tmpDir, 'audit.log') });
    await sink.append({
      timestamp: new Date().toISOString(),
      userId: 'louis',
      role: 'editor',
      roomId: 'room',
      opType: 'connect',
      opHash: '',
    });
    await sink.append({
      timestamp: new Date().toISOString(),
      userId: 'anna',
      role: 'editor',
      roomId: 'room',
      opType: 'update',
      opHash: 'deadbeef',
    });
    await sink.flush();

    const contents = fs.readFileSync(path.join(tmpDir, 'audit.log'), 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].userId).toBe('louis');
    expect(parsed[1].opType).toBe('update');
  });

  it('rotates the active file once it exceeds rotateAtBytes', async () => {
    const filePath = path.join(tmpDir, 'audit.log');
    const sink = new JsonlFileAuditSink({ filePath, rotateAtBytes: 80 });
    for (let i = 0; i < 10; i++) {
      await sink.append({
        timestamp: '2026-05-01T00:00:00Z',
        userId: `u${i}`,
        role: 'editor',
        roomId: 'r',
        opType: 'update',
        opHash: 'aaaaaaaa',
      });
    }
    await sink.flush();
    const files = fs.readdirSync(tmpDir).sort();
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain('audit.log');
  });
});
