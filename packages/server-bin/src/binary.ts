// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Binary download, caching, and execution.
 */

import { createWriteStream, existsSync, mkdirSync, chmodSync, statSync, unlinkSync, createReadStream } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { pipeline } from 'stream/promises';
import { createGunzip, createInflateRaw } from 'zlib';
import { spawn, type SpawnOptions } from 'child_process';
import { fileURLToPath } from 'url';
import { extract } from 'tar';
import { execSync } from 'child_process';
import { getPlatformInfo, getPlatformDescription, type PlatformInfo } from './platform.js';

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
  } catch {
    return 'unknown';
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
    const cachedVersion = (await readFile(VERSION_FILE, 'utf-8')).trim();
    const currentVersion = await getPackageVersion();
    return cachedVersion === currentVersion;
  } catch {
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
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
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
    // Use PowerShell on Windows
    execSync(
      `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
      { stdio: 'pipe' }
    );
  } else {
    // Use unzip on Unix (fallback, shouldn't normally be needed)
    execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'pipe' });
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

  // Clean up any existing files
  if (existsSync(archivePath)) {
    unlinkSync(archivePath);
  }

  // Download archive
  console.log(`Downloading from: ${downloadUrl}`);

  try {
    await downloadFile(downloadUrl, archivePath, onProgress);
  } catch (error) {
    // Try alternate URL patterns
    const altUrls = [
      `${RELEASE_BASE_URL}/server-v${version}/${platformInfo.archiveName}`,
      `${RELEASE_BASE_URL}/${version}/${platformInfo.archiveName}`,
    ];

    let downloaded = false;
    for (const altUrl of altUrls) {
      try {
        console.log(`Trying alternate URL: ${altUrl}`);
        await downloadFile(altUrl, archivePath, onProgress);
        downloaded = true;
        break;
      } catch {
        continue;
      }
    }

    if (!downloaded) {
      throw new Error(
        `Failed to download binary from GitHub releases.\n` +
        `URL: ${downloadUrl}\n` +
        `Error: ${error instanceof Error ? error.message : String(error)}\n\n` +
        `This could mean:\n` +
        `  1. The release doesn't exist yet for version ${version}\n` +
        `  2. Pre-built binaries aren't available for ${platformInfo.targetTriple}\n` +
        `  3. Network connectivity issues\n\n` +
        `Alternatives:\n` +
        `  - Use Docker: npx create-ifc-lite my-app --template server\n` +
        `  - Build from source: cargo build --release -p ifc-lite-server`
      );
    }
  }

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

  // Write version file
  await writeFile(VERSION_FILE, version);

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

    child.on('error', (error) => {
      reject(new Error(`Failed to start server: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        // Process was killed by a signal
        resolve(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
      } else {
        resolve(code ?? 0);
      }
    });

    // Forward signals to child process
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of signals) {
      process.on(sig, () => {
        child.kill(sig);
      });
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
