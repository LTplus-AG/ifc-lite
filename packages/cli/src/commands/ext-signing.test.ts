/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite ext verify` is a gate: a CI pipeline runs it and reads the exit
 * code. `ext-signing.ts` had no test file, and three mutations left the
 * package's 271 tests green — all of them turning a refusal into an
 * acceptance:
 *
 *   - the signer check (`expected.fingerprint !== info.fingerprint`) deleted,
 *     so a bundle signed by ANY key passed `--key trusted.iflk` with exit 0;
 *   - the unsigned-but-`--key`-given refusal downgraded from exit 2 to exit 0;
 *   - `getArg` accepting a following flag as its value, so
 *     `--key --json` silently verified against no key at all.
 *
 * The suite drives the real commands end to end — keygen, pack, sign, verify —
 * because the exit code and the stdout document ARE the contract, and a unit
 * test of the comparison would not have caught the third one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extCommand } from './ext.js';
import {
  extKeygenCommand,
  extPackCommand,
  extSignCommand,
  extVerifyCommand,
} from './ext-signing.js';

/** Thrown in place of a real process.exit so the code is observable. */
class ExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/**
 * The FIRST JSON document on stdout.
 *
 * A real `process.exit()` ends the process; the stub throws instead, and on the
 * fingerprint-mismatch path that throw is caught by the `try` around
 * `verifyBundle`, which then emits a second document. That second write cannot
 * happen in production — it is an artifact of making the exit observable — so
 * the assertions read the document the command actually decided to print.
 *
 * The same artifact hides the exit *code*, which is why `verify()` below reads
 * the FIRST recorded exit rather than the one that escapes: the catch-all also
 * calls `process.exit(2)`, so reading the escaping code made "exit 2" hold for
 * a mismatch branch that exited 0. Verified: changing the mismatch branch to
 * `process.exit(0)` left this file green until the change below.
 */
function firstJsonDoc(out: string): unknown {
  const [first] = out.split(/\n(?=\{)/);
  return JSON.parse(first);
}

describe('ifc-lite ext verify', () => {
  let dir: string;
  let stdout: string;
  let stderr: string;
  /** Every process.exit() code, in call order. Index 0 is the deciding branch. */
  const exitCodes: number[] = [];
  const dirs: string[] = [];

  beforeEach(async () => {
    stdout = '';
    stderr = '';
    exitCodes.length = 0;
    dir = await mkdtemp(join(tmpdir(), 'ifc-lite-ext-sign-'));
    dirs.push(dir);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, 'exit').mockImplementation((((code?: string | number | null) => {
      exitCodes.push(typeof code === 'number' ? code : 0);
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    }) as unknown) as typeof process.exit);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  /** Scaffold a bundle directory and return its path. */
  async function scaffold(name = 'demo'): Promise<string> {
    const path = join(dir, name);
    await extCommand(['init', path, '--id', `ext.${name}`]);
    return path;
  }

  /** Generate a keypair, returning both file paths. */
  async function keypair(prefix: string): Promise<{ pub: string; priv: string }> {
    const base = join(dir, prefix);
    await extKeygenCommand(['--out', base]);
    return { pub: `${base}.public.iflk`, priv: `${base}.private.iflk` };
  }

  /** Run verify and report how it exited. */
  async function verify(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    stdout = '';
    stderr = '';
    exitCodes.length = 0;
    try {
      await extVerifyCommand(args);
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err;
    }
    // exitCodes[0], not the escaping ExitCalled: the mismatch branch's exit is
    // re-raised by the catch-all around verifyBundle, which masks its code.
    return { code: exitCodes[0] ?? 0, stdout, stderr };
  }

  it('accepts a bundle signed by the key the caller expects', async () => {
    const src = await scaffold();
    const key = await keypair('alice');
    const out = join(dir, 'signed.iflx');
    await extPackCommand([src, '--out', out, '--sign', '--key', key.priv]);

    const result = await verify([out, '--key', key.pub, '--json']);
    expect(result.code).toBe(0);
    const doc = firstJsonDoc(result.stdout);
    expect(doc).toMatchObject({ ok: true, signed: true });
  });

  it('REFUSES a bundle signed by a different key, with exit 2', async () => {
    const src = await scaffold();
    const alice = await keypair('alice');
    const mallory = await keypair('mallory');
    const out = join(dir, 'signed-by-mallory.iflx');
    // Validly signed — just not by the signer the caller pinned.
    await extPackCommand([src, '--out', out, '--sign', '--key', mallory.priv]);

    const result = await verify([out, '--key', alice.pub, '--json']);
    expect(result.code).toBe(2);
    const doc = firstJsonDoc(result.stdout) as Record<string, unknown>;
    expect(doc.ok).toBe(false);
    expect(doc.error).toBe('fingerprint_mismatch');
    expect(doc.expectedFingerprint).not.toBe(doc.actualFingerprint);
  });

  it('reports the mismatch on stderr, not stdout, without --json', async () => {
    const src = await scaffold();
    const alice = await keypair('alice');
    const mallory = await keypair('mallory');
    const out = join(dir, 'signed-by-mallory2.iflx');
    await extPackCommand([src, '--out', out, '--sign', '--key', mallory.priv]);

    const result = await verify([out, '--key', alice.pub]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('does not match the expected key');
    expect(result.stdout).toBe('');
  });

  it('REFUSES an unsigned bundle when --key was given, with exit 2', async () => {
    const src = await scaffold();
    const key = await keypair('alice');
    const out = join(dir, 'unsigned.iflx');
    await extPackCommand([src, '--out', out]);

    const result = await verify([out, '--key', key.pub, '--json']);
    expect(result.code).toBe(2);
    expect(firstJsonDoc(result.stdout)).toMatchObject({
      ok: false,
      signed: false,
      error: 'unsigned_with_expected_key',
    });
  });

  it('inspects an unsigned bundle successfully when no --key is given', async () => {
    // The counter-case that keeps the refusal above about --key rather than
    // about being unsigned.
    const src = await scaffold();
    const out = join(dir, 'unsigned2.iflx');
    await extPackCommand([src, '--out', out]);

    const result = await verify([out, '--json']);
    expect(result.code).toBe(0);
    expect(firstJsonDoc(result.stdout)).toMatchObject({ ok: true, signed: false });
  });

  it('does not read the flag after --key as a key path', async () => {
    // `--key --json` means "no key, JSON output". Treating `--json` as the key
    // path would make the run verify against a key file that does not exist —
    // or, on the unsigned path here, quietly assert a signer that was never
    // supplied.
    const src = await scaffold();
    const out = join(dir, 'unsigned3.iflx');
    await extPackCommand([src, '--out', out]);

    const result = await verify([out, '--key', '--json']);
    expect(result.code).toBe(0);
    expect(firstJsonDoc(result.stdout)).toMatchObject({ ok: true, signed: false });
  });

  it('still verifies a bundle signed after the fact by `ext sign`', async () => {
    const src = await scaffold();
    const key = await keypair('alice');
    const packed = join(dir, 'plain.iflx');
    await extPackCommand([src, '--out', packed]);
    const signed = join(dir, 'after.iflx');
    await extSignCommand([src, '--key', key.priv, '--out', signed]);

    expect((await verify([packed, '--json'])).code).toBe(0);
    const result = await verify([signed, '--key', key.pub, '--json']);
    expect(result.code).toBe(0);
    expect(firstJsonDoc(result.stdout)).toMatchObject({ ok: true, signed: true });
  });
});
