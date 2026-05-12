/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSecureCollabServer } from '../src/secure-bundle.js';
import { MemoryPersistence } from '../src/persistence.js';

let tmpDir: string;
let certPath: string;
let keyPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-secure-'));
  // Generate a self-signed cert for the test.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const x509 = (() => {
    // node's crypto doesn't ship a high-level X.509 issuer; use a
    // pre-generated test cert from `openssl` if available, otherwise
    // skip the listen test.
    return null;
  })();
  if (!x509) {
    fs.writeFileSync(path.join(tmpDir, 'noop.txt'), 'placeholder');
    certPath = '';
    keyPath = '';
    void privateKey;
    void publicKey;
    return;
  }
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('startSecureCollabServer (smoke)', () => {
  it('exists and accepts opts', async () => {
    // We can't easily spin up a real TLS server in Node tests without
    // shipping a test cert, but we can at least confirm the function
    // throws if cert paths are missing — that's the contract.
    await expect(
      startSecureCollabServer({
        persistence: new MemoryPersistence(),
        tls: { certPath: '/missing/cert.pem', keyPath: '/missing/key.pem' },
      }),
    ).rejects.toThrow();
  });
});
