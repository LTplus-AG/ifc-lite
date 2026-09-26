/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reviewed, unmodified LandXML source bytes are fetched from their immutable
// upstream blob. Other fixtures continue to use our content-addressed release.

const BLOB = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([a-f0-9]{40})\/(.+)$/;

export function pinnedBlobRawUrl(blobUrl) {
  const blob = BLOB.exec(blobUrl);
  if (!blob) throw new Error('expected a commit-pinned GitHub blob URL');
  const [, owner, repository, commit, path] = blob;
  return `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${path}`;
}

export function fixtureDownloadUrl(baseUrl, entry) {
  const source = entry.provenance?.source;
  const blob = typeof source?.blob_url === 'string' ? BLOB.exec(source.blob_url) : null;
  const reviewedSourceBytes =
    /\.(xml|landxml)$/i.test(entry.path) &&
    entry.provenance?.modification?.status === 'unmodified' &&
    source?.sha256 === entry.sha256 &&
    blob;
  if (reviewedSourceBytes) {
    return pinnedBlobRawUrl(source.blob_url);
  }
  return `${baseUrl}/${entry.sha256}`;
}
