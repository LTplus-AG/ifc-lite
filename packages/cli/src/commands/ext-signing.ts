/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite ext (signing subcommands)
 *
 *   ifc-lite ext keygen --out <prefix> [--label <name>]
 *   ifc-lite ext pack <bundle-dir> --out <bundle.iflx>
 *   ifc-lite ext sign <bundle-dir-or-iflx> --key <private.iflk> --out <bundle.iflx>
 *   ifc-lite ext verify <bundle.iflx> [--key <public.iflk>]
 *
 * All four are part of the Phase 5 prototype (see RFC §10). They give
 * authors a way to sign and verify bundles today, before any hosted
 * registry exists.
 */

import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  importPrivateKey,
  importPublicKey,
  packBundle,
  signBundle,
  unpackBundleWithSignature,
  verifyBundle,
  type Bundle,
  type SerialisedKey,
  type SerialisedPrivateKey,
  type SerialisedPublicKey,
} from '@ifc-lite/extensions';
import { loadBundleFromDirectory } from '@ifc-lite/extensions/node';
import { hasFlag, fatal } from '../output.js';

// ---------------------------------------------------------------------------
// keygen
// ---------------------------------------------------------------------------

export async function extKeygenCommand(args: string[]): Promise<void> {
  const outPrefix = getArg(args, '--out')
    ?? args.find((a) => !a.startsWith('-'))
    ?? fatal('Usage: ifc-lite ext keygen --out <prefix> [--label <name>]');
  const label = getArg(args, '--label');

  const publicPath = resolve(`${outPrefix}.public.iflk`);
  const privatePath = resolve(`${outPrefix}.private.iflk`);

  if (existsSync(publicPath)) fatal(`File already exists: ${publicPath}`);
  if (existsSync(privatePath)) fatal(`File already exists: ${privatePath}`);

  const pair = await generateKeyPair({ label });
  const pub = exportPublicKey(pair);
  const priv = await exportPrivateKey(pair);

  await writeFile(publicPath, `${JSON.stringify(pub, null, 2)}\n`, 'utf-8');
  await writeFile(privatePath, `${JSON.stringify(priv, null, 2)}\n`, 'utf-8');

  // Best-effort POSIX permissions for the private file.
  try {
    await chmod(privatePath, 0o600);
  } catch (err) {
    // Non-fatal (non-POSIX FS, no permission to chmod), but still log
    // so users on systems where this matters know the file isn't 0600.
    process.stderr.write(
      `Warning: could not chmod 0600 on ${privatePath}: ${err instanceof Error ? err.message : err}\n`,
    );
    process.stderr.write(`Verify the file's permissions manually before sharing this machine.\n`);
  }

  process.stderr.write(`Generated Ed25519 keypair.\n`);
  process.stderr.write(`  Public:      ${publicPath}\n`);
  process.stderr.write(`  Private:     ${privatePath}\n`);
  process.stderr.write(`  Fingerprint: ${pair.fingerprint}\n`);
  process.stderr.write(`\n`);
  process.stderr.write(`Keep the private file secret. Anyone with the file can sign bundles\n`);
  process.stderr.write(`as you. Never commit it to source control.\n`);
}

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------

export async function extPackCommand(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith('-'))
    ?? fatal('Usage: ifc-lite ext pack <bundle-dir> [--out <bundle.iflx>] [--sign --key <private.iflk>]');
  const out = getArg(args, '--out');
  const keyPath = getArg(args, '--key');
  const sign = hasFlag(args, '--sign') || !!keyPath;

  const bundle = await loadOrFatal(dir);
  const outPath = resolve(out ?? `${bundle.manifest.id}-${bundle.manifest.version}.iflx`);
  if (existsSync(outPath) && !hasFlag(args, '--force')) {
    fatal(`Output already exists: ${outPath} (use --force to overwrite)`);
  }

  let bytes: Uint8Array;
  if (sign) {
    if (!keyPath) {
      fatal('--sign requires --key <path-to-private.iflk>');
    }
    const key = await loadPrivateKey(keyPath);
    const signature = await signBundle(bundle, key);
    bytes = packBundle(bundle, signature);
    await writeFile(outPath, bytes);
    process.stderr.write(`Packed ${bundle.manifest.id}@${bundle.manifest.version} → ${outPath}\n`);
    process.stderr.write(`Signed by fingerprint: ${key.fingerprint}\n`);
  } else {
    bytes = packBundle(bundle);
    await writeFile(outPath, bytes);
    process.stderr.write(`Packed ${bundle.manifest.id}@${bundle.manifest.version} → ${outPath}\n`);
    process.stderr.write(`(unsigned — pass --sign --key to sign)\n`);
  }
}

// ---------------------------------------------------------------------------
// sign — add a signature to an already-packed .iflx (or a bundle dir)
// ---------------------------------------------------------------------------

export async function extSignCommand(args: string[]): Promise<void> {
  const target = args.find((a) => !a.startsWith('-'))
    ?? fatal('Usage: ifc-lite ext sign <bundle-dir-or-iflx> --key <private.iflk> [--out <bundle.iflx>]');
  const keyPath = getArg(args, '--key') ?? fatal('--key <private.iflk> is required');
  const out = getArg(args, '--out');

  const bundle = await loadOrFatal(target);
  const key = await loadPrivateKey(keyPath);
  const signature = await signBundle(bundle, key);
  const bytes = packBundle(bundle, signature);

  const outPath = resolve(out ?? `${bundle.manifest.id}-${bundle.manifest.version}.iflx`);
  if (existsSync(outPath) && !hasFlag(args, '--force')) {
    fatal(`Output already exists: ${outPath} (use --force to overwrite)`);
  }
  await writeFile(outPath, bytes);
  process.stderr.write(`Signed ${bundle.manifest.id}@${bundle.manifest.version} → ${outPath}\n`);
  process.stderr.write(`Fingerprint: ${key.fingerprint}\n`);
}

// ---------------------------------------------------------------------------
// verify — inspect a .iflx, optionally checking signature against a key
// ---------------------------------------------------------------------------

export async function extVerifyCommand(args: string[]): Promise<void> {
  const target = args.find((a) => !a.startsWith('-'))
    ?? fatal('Usage: ifc-lite ext verify <bundle.iflx> [--key <public.iflk>]');
  const keyPath = getArg(args, '--key');
  const json = hasFlag(args, '--json');

  const bytes = new Uint8Array(await readFile(resolve(target)));
  const unpacked = unpackBundleWithSignature(bytes);
  if (!unpacked.ok) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, errors: unpacked.errors }, null, 2)}\n`);
    } else {
      process.stderr.write(`✗ Bundle did not unpack:\n`);
      for (const err of unpacked.errors) {
        process.stderr.write(`  ${err.path || '<root>'}: ${err.message}\n`);
      }
    }
    process.exit(1);
  }

  const { bundle, signature } = unpacked.value;

  if (!signature) {
    // If the caller passed --key, they're asserting an expected signer
    // — an unsigned bundle never matches that. Fail with a non-zero
    // exit so CI pipelines that gate on signer identity refuse the
    // bundle instead of letting it pass silently.
    if (keyPath) {
      if (json) {
        process.stdout.write(`${JSON.stringify({
          ok: false,
          id: bundle.manifest.id,
          version: bundle.manifest.version,
          signed: false,
          error: 'unsigned_with_expected_key',
          message: 'Bundle is unsigned but --key was provided.',
        }, null, 2)}\n`);
      } else {
        process.stderr.write(`✗ Bundle is unsigned but --key was provided.\n`);
        process.stderr.write(`   Re-run without --key to inspect, or sign the bundle first.\n`);
      }
      process.exit(2);
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        id: bundle.manifest.id,
        version: bundle.manifest.version,
        signed: false,
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`Bundle: ${bundle.manifest.id}@${bundle.manifest.version}\n`);
      process.stderr.write(`Status: unsigned\n`);
    }
    return;
  }

  try {
    const info = await verifyBundle(bundle, signature);
    if (keyPath) {
      const expected = await loadPublicKey(keyPath);
      if (expected.fingerprint !== info.fingerprint) {
        if (json) {
          process.stdout.write(`${JSON.stringify({
            ok: false,
            id: bundle.manifest.id,
            version: bundle.manifest.version,
            signed: true,
            error: 'fingerprint_mismatch',
            expectedFingerprint: expected.fingerprint,
            actualFingerprint: info.fingerprint,
          }, null, 2)}\n`);
        } else {
          process.stderr.write(`✗ Signature is valid but does not match the expected key.\n`);
          process.stderr.write(`   Expected: ${expected.fingerprint}\n`);
          process.stderr.write(`   Actual:   ${info.fingerprint}\n`);
        }
        process.exit(2);
      }
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        id: bundle.manifest.id,
        version: bundle.manifest.version,
        signed: true,
        fingerprint: info.fingerprint,
        signedAt: info.signedAt,
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`Bundle: ${bundle.manifest.id}@${bundle.manifest.version}\n`);
      process.stderr.write(`Status: ✓ signed (${signature.algorithm})\n`);
      process.stderr.write(`Fingerprint: ${info.fingerprint}\n`);
      process.stderr.write(`Signed at:   ${info.signedAt}\n`);
    }
  } catch (err) {
    if (json) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        id: bundle.manifest.id,
        version: bundle.manifest.version,
        signed: true,
        error: err instanceof Error ? err.name : 'verify_failed',
        message: err instanceof Error ? err.message : String(err),
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`✗ Signature verification failed: ${err instanceof Error ? err.message : err}\n`);
    }
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadOrFatal(target: string): Promise<Bundle> {
  const path = resolve(target);
  if (path.toLowerCase().endsWith('.iflx')) {
    const bytes = new Uint8Array(await readFile(path));
    const r = unpackBundleWithSignature(bytes);
    if (!r.ok) {
      process.stderr.write(`✗ Bundle did not unpack:\n`);
      for (const err of r.errors) {
        process.stderr.write(`  ${err.path || '<root>'}: ${err.message}\n`);
      }
      process.exit(1);
    }
    return r.value.bundle;
  }
  const r = await loadBundleFromDirectory(path);
  if (!r.ok) {
    process.stderr.write(`✗ Bundle did not load:\n`);
    for (const err of r.errors) {
      process.stderr.write(`  ${err.path || '<root>'}: ${err.message}\n`);
    }
    process.exit(1);
  }
  return r.value;
}

async function loadPrivateKey(path: string) {
  const raw = JSON.parse(await readFile(resolve(path), 'utf-8')) as SerialisedKey;
  if (raw.kind !== 'private') fatal(`${path} is a public key file; sign requires a private key.`);
  return importPrivateKey(raw as SerialisedPrivateKey);
}

async function loadPublicKey(path: string) {
  const raw = JSON.parse(await readFile(resolve(path), 'utf-8')) as SerialisedKey;
  if (raw.kind !== 'public') {
    // A private key file also contains a public component; allow it.
    return importPublicKey({
      format: 'iflk',
      version: 1,
      kind: 'public',
      algorithm: raw.algorithm,
      publicKey: (raw as SerialisedPrivateKey).publicKey,
      label: raw.label,
      createdAt: raw.createdAt,
    });
  }
  return importPublicKey(raw as SerialisedPublicKey);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('-')) return undefined;
  return value;
}
