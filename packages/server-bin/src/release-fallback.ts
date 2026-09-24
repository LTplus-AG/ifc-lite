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

const GITHUB_REPO = 'LTplus-AG/ifc-lite';
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases`;

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
function usableAsset(release: ApiRelease, archiveName: string): FallbackRelease | null {
  if (release.draft === true || release.prerelease === true) return null;
  if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) return null;
  const version = release.tag_name.slice(1);
  if (!parseSemver(version) || !Array.isArray(release.assets)) return null;

  const assets = (release.assets as ApiAsset[]).filter(
    (a) => typeof a.name === 'string' && (a.state === undefined || a.state === 'uploaded')
  );
  const archive = assets.find((a) => a.name === archiveName);
  const hasChecksum = assets.some((a) => a.name === `${archiveName}.sha256` || a.name === 'SHA256SUMS');
  if (!archive || !hasChecksum || typeof archive.browser_download_url !== 'string') return null;
  return { version, assetUrl: archive.browser_download_url };
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
  let best: FallbackRelease | null = null;
  let bestSemver: [number, number, number] | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${RELEASES_API_URL}?per_page=${PER_PAGE}&page=${page}`;
    let releases: unknown;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'ifc-lite-server-bin',
          Accept: 'application/vnd.github+json',
        },
      });
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

    for (const release of releases as ApiRelease[]) {
      const candidate = usableAsset(release, archiveName);
      if (!candidate) continue;
      const semver = parseSemver(candidate.version);
      if (!semver) continue;
      // Only ever fall BACK: a release newer than the requested version is
      // not what this package version was built against.
      if (requested && compareSemver(semver, requested) >= 0) continue;
      if (!bestSemver || compareSemver(semver, bestSemver) > 0) {
        best = candidate;
        bestSemver = semver;
      }
    }

    // Releases are listed newest first, so the first page holding a
    // candidate holds the newest one; a short page is the end of the list.
    if (best || releases.length < PER_PAGE) break;
  }

  return best
    ? { found: best }
    : {
        found: null,
        reason: `no release older than v${requestedVersion} in the ${MAX_PAGES * PER_PAGE} most recent carries ${archiveName} with a checksum`,
      };
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
