// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fallback release resolution for when this package version's own release
 * carries no archive for the current platform (#5525).
 *
 * binary.ts derives the release tag from the package version, so a version
 * that reaches npm without a matching `v<version>` release (1.20.0 and 1.21.0
 * both did) 404s on every platform. Instead of failing, look up the newest
 * OLDER `vX.Y.Z` release that does carry this platform's archive, via the
 * unauthenticated GitHub releases API. The caller verifies the fallback's
 * checksum exactly as it does the primary download.
 */

import { parseExpectedSha256 } from './checksum-parse.js';

const GITHUB_REPO = 'LTplus-AG/ifc-lite';
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases`;
const RELEASES_DOWNLOAD_URL = `${RELEASES_PAGE_URL}/download`;

/**
 * The repo publishes one GitHub release per npm package, so `v*` server
 * releases are sparse in the listing. Five pages of 100 cover weeks of
 * releases while staying well under the 60/hour unauthenticated rate limit.
 */
const PER_PAGE = 100;
const MAX_PAGES = 5;

/** A download that failed with an HTTP status (as opposed to a network error). */
export class HttpStatusError extends Error {
  constructor(readonly status: number, statusText: string) {
    super(`Download failed: ${status} ${statusText}`);
    this.name = 'HttpStatusError';
  }
}

export interface FallbackRelease {
  /** Semver of the release, without the leading `v`. */
  version: string;
  /** Browser download URL of this platform's archive in that release. */
  assetUrl: string;
}

export type FallbackLookup =
  | { found: FallbackRelease }
  | { found: null; reason: string };

interface ApiAsset {
  name?: unknown;
  browser_download_url?: unknown;
  state?: unknown;
}

interface ApiRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Return this release's asset URL for `archiveName` when the release is a
 * published `vX.Y.Z` release carrying both the archive and a checksum
 * (per-asset sidecar or SHA256SUMS). A release with the archive but no
 * checksum would fail the fail-closed verification anyway, so skip it here
 * and keep looking for one that can actually install.
 */
/** A fallback candidate, and whether its only checksum is a release-wide SHA256SUMS. */
type Candidate = FallbackRelease & { sumsOnly: boolean };

/**
 * A release-wide SHA256SUMS need not list every platform: one that covers the
 * others but not this archive would be chosen, downloaded, and then fail the
 * fail-closed verification, aborting the install while an older release could
 * still have worked. So a SHA256SUMS-only candidate counts only once its body
 * is seen to carry a line for this archive.
 */
async function sumsCoverArchive(candidate: Candidate, archiveName: string): Promise<boolean> {
  if (!candidate.sumsOnly) return true;
  try {
    const response = await fetch(candidate.assetUrl.replace(/[^/]+$/, 'SHA256SUMS'), {
      headers: { 'User-Agent': 'ifc-lite-server-bin' },
      redirect: 'follow',
    });
    return response.ok && parseExpectedSha256(await response.text(), archiveName) !== null;
  } catch {
    // Unreadable now means unverifiable at install time too: try an older one.
    return false;
  }
}

function usableAsset(release: ApiRelease, archiveName: string): Candidate | null {
  if (release.draft === true || release.prerelease === true) return null;
  if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) return null;
  const version = release.tag_name.slice(1);
  if (!parseSemver(version) || !Array.isArray(release.assets)) return null;

  const assets = (release.assets as ApiAsset[]).filter(
    (a) => typeof a.name === 'string' && (a.state === undefined || a.state === 'uploaded')
  );
  const archive = assets.find((a) => a.name === archiveName);
  const hasSidecar = assets.some((a) => a.name === `${archiveName}.sha256`);
  const hasSums = assets.some((a) => a.name === 'SHA256SUMS');
  if (!archive || !(hasSidecar || hasSums) || typeof archive.browser_download_url !== 'string') return null;
  // The checksum is fetched relative to this URL, so it must be the release's
  // own asset on github.com, not whatever the API response names.
  if (!archive.browser_download_url.startsWith(`${RELEASES_DOWNLOAD_URL}/${release.tag_name}/`)) return null;
  return { version, assetUrl: archive.browser_download_url, sumsOnly: !hasSidecar };
}

/**
 * Find the newest release OLDER than `requestedVersion` that carries
 * `archiveName` plus its checksum. Never throws: API, rate-limit and network
 * failures come back as `{ found: null, reason }` so the caller can put them
 * in its error message.
 */
export async function findFallbackRelease(
  archiveName: string,
  requestedVersion: string
): Promise<FallbackLookup> {
  const requested = parseSemver(requestedVersion);
  // Without a plain X.Y.Z (e.g. a prerelease) "older" is undefined, and a
  // fallback could pick a newer or unrelated release. Refuse instead.
  if (!requested) {
    return { found: null, reason: `v${requestedVersion} is not a plain X.Y.Z version, so no older release can be chosen` };
  }

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${RELEASES_API_URL}?per_page=${PER_PAGE}&page=${page}`;
    let releases: unknown;
    try {
      const response = await fetch(url, { headers: apiHeaders() });
      if (!response.ok) {
        const rateLimited =
          (response.status === 403 || response.status === 429) &&
          response.headers?.get('x-ratelimit-remaining') === '0';
        return {
          found: null,
          reason: rateLimited
            ? 'the GitHub API rate limit for unauthenticated requests is exhausted (retry within the hour)'
            : `the GitHub releases API answered ${response.status} ${response.statusText}`,
        };
      }
      releases = await response.json();
    } catch (error) {
      return {
        found: null,
        reason: `the GitHub releases API could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!Array.isArray(releases)) {
      return { found: null, reason: 'the GitHub releases API returned an unexpected response' };
    }

    const candidates: Array<{ candidate: Candidate; semver: [number, number, number] }> = [];
    for (const release of releases as ApiRelease[]) {
      const candidate = usableAsset(release, archiveName);
      if (!candidate) continue;
      const semver = parseSemver(candidate.version);
      if (!semver) continue;
      // Only ever fall BACK: a release newer than the requested version is
      // not what this package version was built against.
      if (compareSemver(semver, requested) >= 0) continue;
      candidates.push({ candidate, semver });
    }

    // Releases are listed newest first, so this page's candidates are newer
    // than any later page's; the newest one whose checksum covers the archive
    // wins.
    candidates.sort((a, b) => compareSemver(b.semver, a.semver));
    for (const { candidate } of candidates) {
      if (await sumsCoverArchive(candidate, archiveName)) {
        return { found: { version: candidate.version, assetUrl: candidate.assetUrl } };
      }
    }

    // A short page is the end of the list.
    if (releases.length < PER_PAGE) break;
  }

  return {
    found: null,
    reason: `no release older than v${requestedVersion} in the ${MAX_PAGES * PER_PAGE} most recent carries ${archiveName} with a checksum`,
  };
}

/**
 * Headers for the releases API. A `GITHUB_TOKEN` / `GH_TOKEN` in the
 * environment (CI, shared NAT: where the 60/hour unauthenticated limit runs
 * out first) is sent so the lookup gets the authenticated limit.
 */
function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'ifc-lite-server-bin',
    Accept: 'application/vnd.github+json',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * The version sidecar (`.cache/version.txt`). Its first line is the package
 * version the cache is keyed on; a fallback install adds a second line naming
 * the release that actually supplied the binary, so every later run can say so
 * instead of the substitution being visible only in a (usually hidden)
 * postinstall log.
 */
export function versionSidecar(version: string, fallbackVersion?: string): string {
  return fallbackVersion ? `${version}\nfallback ${fallbackVersion}\n` : version;
}

export function parseVersionSidecar(text: string): { version: string; fallback: string | null } {
  const [first = '', second = ''] = text.trim().split(/\r?\n/);
  const fallback = /^fallback (\S+)$/.exec(second.trim());
  return { version: first.trim(), fallback: fallback ? fallback[1] : null };
}

/** The warning printed on every run that reuses a fallback binary. */
export function fallbackInUseWarning(version: string, fallbackVersion: string): string {
  return (
    `Warning: @ifc-lite/server-bin@${version} is running the server binary from release v${fallbackVersion}, ` +
    `because release v${version} had no binary for this platform when it was installed.\n` +
    `Warning: run "npx @ifc-lite/server-bin download" to retry v${version}, or pin: npm i @ifc-lite/server-bin@${fallbackVersion}`
  );
}

/**
 * The error text for "no binary for this version and no usable fallback".
 * It names the concrete fix (pin a version whose release has binaries)
 * rather than an alternative install route.
 */
export function noBinaryMessage(details: {
  version: string;
  downloadUrl: string;
  errorText: string;
  reason: string;
  archiveName: string;
}): string {
  return (
    `Failed to download the IFC-Lite server binary for @ifc-lite/server-bin@${details.version}.\n` +
    `URL: ${details.downloadUrl}\n` +
    `Error: ${details.errorText}\n` +
    `No fallback release was used: ${details.reason}.\n\n` +
    `Fix: install a server-bin version whose GitHub release carries binaries.\n` +
    `  1. Pick the newest "vX.Y.Z" release listing ${details.archiveName}: ${RELEASES_PAGE_URL}\n` +
    `  2. npm i @ifc-lite/server-bin@X.Y.Z   (or: npx @ifc-lite/server-bin@X.Y.Z)\n` +
    `Or build from source: cargo build --release -p ifc-lite-server`
  );
}
