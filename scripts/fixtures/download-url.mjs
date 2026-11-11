/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where a fixture's bytes come from. Reviewed, unmodified LandXML/Gaussian source bytes,
// upstream archives and upstream files are fetched from their immutable upstream blob; other
// fixtures use our content-addressed release. The fetcher, the uploader and
// the manifest builder all read that decision from `upstreamBlobUrl`, so the
// uploader can never publish a file the fetcher takes from upstream.

import { isCanonicalFixturePath, isGaussianFixturePath } from './manifest-validation.mjs';

const BLOB = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([a-f0-9]{40})\/(.+)$/;

export function pinnedBlobRawUrl(blobUrl) {
  const blob = BLOB.exec(blobUrl);
  if (!blob) throw new Error('expected a commit-pinned GitHub blob URL');
  const [, owner, repository, commit, path] = blob;
  return `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${path}`;
}

/**
 * The commit-pinned GitHub blob this entry's bytes are fetched from, or null
 * when they are served from this project's fixture release.
 */
export function upstreamBlobUrl(entry) {
  if (!isCanonicalFixturePath(entry.path)) {
    throw new Error('fixture path must be a canonical relative POSIX path');
  }
  if (entry.upstream_archive) return entry.upstream_archive.blob_url;
  if (entry.upstream_file) return entry.upstream_file.blob_url;
  const source = entry.provenance?.source;
  const reviewedSourceBytes =
    (/\.(xml|landxml)$/i.test(entry.path) || isGaussianFixturePath(entry.path)) &&
    entry.provenance?.modification?.status === 'unmodified' &&
    source?.sha256 === entry.sha256 &&
    typeof source?.blob_url === 'string' &&
    BLOB.test(source.blob_url);
  return reviewedSourceBytes ? source.blob_url : null;
}

export function fixtureDownloadUrl(baseUrl, entry) {
  const blobUrl = upstreamBlobUrl(entry);
  return blobUrl ? pinnedBlobRawUrl(blobUrl) : `${baseUrl}/${entry.sha256}`;
}
