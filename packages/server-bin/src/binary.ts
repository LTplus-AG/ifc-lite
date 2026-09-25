// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Binary download, caching, and execution.
 */

import { existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { spawn, type SpawnOptions } from 'child_process';
import { fileURLToPath } from 'url';
import { extract } from 'tar';
import { execFileSync } from 'child_process';
import { getPlatformInfo, getPlatformDescription, type PlatformInfo } from './platform.js';
import { verifyArchiveChecksum } from './checksum.js';
import { fallbackInUseWarning, findFallbackRelease, HttpStatusError, noBinaryMessage, parseVersionSidecar,
  versionSidecar, type FallbackLookup } from './release-fallback.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// GitHub release URL pattern
const GITHUB_REPO = 'LTplus-AG/ifc-lite';
const RELEASE_BASE_URL = `https://github.com/${GITHUB_REPO}/releases/download`;

// Cache directory (inside the package for portability)
const CACHE_DIR = join(__dirname, '..', '.cache');
const VERSION_FILE = join(CACHE_DIR, 'version.txt');

/**
 * Get the current package version.
 */
async function getPackageVersion(): Promise<string> {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    return pkg.version;
  } catch (error) {
    throw new Error(
      `Cannot determine @ifc-lite/server-bin package version (corrupt or unreadable package.json): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get the path to the cached binary.
 */
export function getBinaryPath(platformInfo?: PlatformInfo): string {
  const info = platformInfo ?? getPlatformInfo();
  return join(CACHE_DIR, info.binaryName);
}

/**
 * Check if binary exists and is the correct version.
 */
export async function isBinaryCached(): Promise<boolean> {
  const binaryPath = getBinaryPath();

  if (!existsSync(binaryPath)) {
    return false;
  }

  // Check version file
  if (!existsSync(VERSION_FILE)) {
    return false;
  }

  try {
    const cached = parseVersionSidecar(await readFile(VERSION_FILE, 'utf-8'));
    const currentVersion = await getPackageVersion();
    if (cached.version !== currentVersion) return false;
    if (cached.fallback) console.warn(fallbackInUseWarning(currentVersion, cached.fallback));
    return true;
  } catch {
    // Legitimately silent: an unreadable version sidecar means "not cached",
    // which triggers a fresh download — the same, safe outcome as a genuine
    // cache miss. The download path reports its own failures.
    return false;
  }
}

/**
 * Download progress callback type.
 */
export type ProgressCallback = (downloaded: number, total: number) => void;

/**
 * Download file with progress reporting.
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ifc-lite-server-bin',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new HttpStatusError(response.status, response.statusText);
  }

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let downloaded = 0;

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  // Ensure directory exists
  mkdirSync(dirname(destPath), { recursive: true });

  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    downloaded += value.length;

    if (onProgress && total > 0) {
      onProgress(downloaded, total);
    }
  }

  // Write all chunks to file
  const buffer = Buffer.concat(chunks);
  await writeFile(destPath, buffer);
}

/**
 * Extract tar.gz archive.
 */
async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });

  await extract({
    file: archivePath,
    cwd: destDir,
  });
}

/**
 * Extract zip archive (Windows).
 * Uses PowerShell on Windows, unzip on Unix (fallback).
 */
async function extractZip(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });

  if (process.platform === 'win32') {
    // Use PowerShell on Windows. Pass paths via environment variables and
    // reference them with $env: + -LiteralPath so quoting/wildcard handling in
    // the path cannot break out of the command.
    const psScript =
      `$ErrorActionPreference='Stop'; ` +
      `Expand-Archive -LiteralPath $env:IL_ARCHIVE -DestinationPath $env:IL_DEST -Force`;
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      stdio: 'pipe',
      env: { ...process.env, IL_ARCHIVE: archivePath, IL_DEST: destDir },
    });
  } else {
    // Use unzip on Unix (fallback, shouldn't normally be needed). execFileSync
    // passes argv directly with no shell, so path metacharacters are inert.
    execFileSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'pipe' });
  }
}

/**
 * Extract archive based on type.
 */
async function extractArchive(
  archivePath: string,
  destDir: string,
  archiveType: 'tar.gz' | 'zip'
): Promise<void> {
  if (archiveType === 'zip') {
    await extractZip(archivePath, destDir);
  } else {
    await extractTarGz(archivePath, destDir);
  }
}

/**
 * Download and cache the binary for the current platform.
 */
export async function downloadBinary(onProgress?: ProgressCallback): Promise<string> {
  const platformInfo = getPlatformInfo();
  const version = await getPackageVersion();

  console.log(`Downloading IFC-Lite server for ${getPlatformDescription(platformInfo)}...`);
  console.log(`Version: ${version}`);

  // Construct download URL
  const downloadUrl = `${RELEASE_BASE_URL}/v${version}/${platformInfo.archiveName}`;
  const archivePath = join(CACHE_DIR, platformInfo.archiveName);
  const binaryPath = getBinaryPath(platformInfo);

  if (existsSync(archivePath)) unlinkSync(archivePath); // stale partial download

  // Download archive
  console.log(`Downloading from: ${downloadUrl}`);

  // Track the asset URL that actually succeeded so the checksum sidecar is
  // fetched from the SAME release/asset that produced this archive.
  let resolvedAssetUrl = downloadUrl;
  let fallbackVersion: string | undefined;

  try {
    await downloadFile(downloadUrl, archivePath, onProgress);
  } catch (error) {
    // Try alternate URL patterns
    const altUrls = [
      `${RELEASE_BASE_URL}/server-v${version}/${platformInfo.archiveName}`,
      `${RELEASE_BASE_URL}/${version}/${platformInfo.archiveName}`,
    ];

    // Only a clean "not found" on every URL means this version has no
    // release; any other failure (network, 5xx) must not silently swap in a
    // different server version.
    let allNotFound = error instanceof HttpStatusError && error.status === 404;
    let downloaded = false;
    for (const altUrl of altUrls) {
      try {
        console.log(`Trying alternate URL: ${altUrl}`);
        await downloadFile(altUrl, archivePath, onProgress);
        resolvedAssetUrl = altUrl;
        downloaded = true;
        break;
      } catch (altError) {
        // Speculative URL shapes: a miss is the expected case. Only whether
        // it was a 404 matters, for the fallback decision below.
        allNotFound &&= altError instanceof HttpStatusError && altError.status === 404;
        continue;
      }
    }

    if (!downloaded) {
      const errorText = error instanceof Error ? error.message : String(error);
      const lookup: FallbackLookup = allNotFound
        ? await findFallbackRelease(platformInfo.archiveName, version)
        : { found: null, reason: `the download failed for a reason other than a missing release (${errorText})` };

      if (!lookup.found) {
        throw new Error(noBinaryMessage({
          version, downloadUrl, errorText, reason: lookup.reason, archiveName: platformInfo.archiveName,
        }));
      }

      const fallback = lookup.found;
      console.warn(
        `Warning: @ifc-lite/server-bin@${version} has no published binary for ${platformInfo.targetTriple} ` +
        `(release v${version} is missing or lacks this platform's archive).\n` +
        `Warning: falling back to the server binary from release v${fallback.version}.`
      );
      console.log(`Downloading from: ${fallback.assetUrl}`);
      try {
        await downloadFile(fallback.assetUrl, archivePath, onProgress);
      } catch (fallbackError) {
        throw new Error(
          `Release v${version} has no binary, and downloading the fallback from v${fallback.version} failed: ` +
          `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n` +
          `Fix: npm i @ifc-lite/server-bin@${fallback.version}`
        );
      }
      resolvedAssetUrl = fallback.assetUrl;
      fallbackVersion = fallback.version;
    }
  }

  // Verify archive integrity before we extract / chmod / execute it. Fails
  // closed on a mismatch AND on a missing checksum: every release this
  // package version can download publishes a .sha256 sidecar per archive
  // (see checksum.ts for why that mapping holds).
  await verifyArchiveChecksum(archivePath, resolvedAssetUrl, platformInfo.archiveName);

  console.log('Extracting archive...');

  // Extract archive based on type
  await extractArchive(archivePath, CACHE_DIR, platformInfo.archiveType);

  // Make binary executable (Unix only)
  if (platformInfo.platform !== 'win32') {
    chmodSync(binaryPath, 0o755);
  }

  // Verify binary exists
  if (!existsSync(binaryPath)) {
    throw new Error(
      `Binary not found after extraction: ${binaryPath}\n` +
      `Archive may have unexpected structure.`
    );
  }

  // Keyed on THIS package's version even for a fallback install (reused, not
  // re-resolved every run); the sidecar names the fallback so each run warns.
  await writeFile(VERSION_FILE, versionSidecar(version, fallbackVersion));

  // Clean up archive
  unlinkSync(archivePath);

  console.log(`Binary installed at: ${binaryPath}`);
  return binaryPath;
}

/**
 * Ensure binary is available, downloading if necessary.
 */
export async function ensureBinary(onProgress?: ProgressCallback): Promise<string> {
  if (await isBinaryCached()) {
    return getBinaryPath();
  }
  return downloadBinary(onProgress);
}

/**
 * Run the binary with the given arguments.
 */
export async function runBinary(args: string[] = []): Promise<number> {
  const binaryPath = await ensureBinary((downloaded, total) => {
    const percent = Math.round((downloaded / total) * 100);
    process.stdout.write(`\rDownloading: ${percent}%`);
    if (downloaded === total) {
      console.log(''); // New line after progress
    }
  });

  return new Promise((resolve, reject) => {
    const options: SpawnOptions = {
      stdio: 'inherit',
      env: process.env,
    };

    const child = spawn(binaryPath, args, options);

    // Forward signals to child process. Track the handlers so they can be
    // removed once the child exits or fails to start, preventing unbounded
    // listener accumulation and stale child.kill calls on subsequent calls.
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = new Map<NodeJS.Signals, () => void>();
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      for (const [sig, handler] of handlers) {
        process.removeListener(sig, handler);
      }
    };

    child.on('error', (error) => {
      cleanup();
      reject(new Error(`Failed to start server: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      cleanup();
      if (signal) {
        // Process was killed by a signal
        resolve(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
      } else {
        resolve(code ?? 0);
      }
    });

    for (const sig of signals) {
      const handler = () => {
        child.kill(sig);
      };
      handlers.set(sig, handler);
      process.on(sig, handler);
    }
  });
}

/**
 * Get binary info without downloading.
 */
export function getBinaryInfo(): {
  platform: PlatformInfo;
  binaryPath: string;
  cacheDir: string;
  isCached: boolean;
} {
  const platform = getPlatformInfo();
  const binaryPath = getBinaryPath(platform);
  return {
    platform,
    binaryPath,
    cacheDir: CACHE_DIR,
    isCached: existsSync(binaryPath) && existsSync(VERSION_FILE),
  };
}
