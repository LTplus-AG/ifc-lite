/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shared structural validation for the public fixture catalogue. Version 1 is
// intentionally still accepted: moving the existing corpus to v2 requires a
// rights review for every historical byte, not a mechanical JSON rewrite.

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const CAPABILITY_STATES = new Set(['rendered', 'preserved-only', 'unsupported', 'refused']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isLandXmlPath = (value) => typeof value === 'string' && /\.(xml|landxml)$/i.test(value);

function invalid(errors, where, message) {
  errors.push(`${where}: ${message}`);
}

function requireText(value, where, errors) {
  if (!isText(value)) invalid(errors, where, 'must be a non-empty string');
}

function requireUrl(value, where, errors) {
  requireText(value, where, errors);
  if (!isText(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') invalid(errors, where, 'must use https');
  } catch (error) {
    // The detailed URL parser message is deliberately not surfaced: it can
    // include an untrusted URL verbatim, while this stable error points to the
    // exact manifest field the maintainer must repair.
    const kind = error instanceof Error ? error.name : 'parse failure';
    invalid(errors, where, `must be a valid URL (${kind})`);
  }
}

/**
 * Source fixtures accepted for the public corpus must name the exact GitHub
 * blob they were reviewed from. Merely putting a commit-looking value in a
 * query parameter does not make a branch URL immutable.
 */
function requirePinnedGitHubBlobUrl(value, commit, where, errors) {
  requireUrl(value, where, errors);
  if (!isText(value)) return;

  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const match = /^\/([^/]+)\/([^/]+)\/blob\/([a-f0-9]{40})\/(.+)$/.exec(url.pathname);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !match
  ) {
    invalid(errors, where, 'must be a pinned https://github.com/<owner>/<repo>/blob/<40-char-commit>/<path> URL');
    return;
  }
  if (!isText(commit) || match[3] !== commit) {
    invalid(errors, where, 'commit path segment must equal provenance.source.commit (immutable source)');
  }
}

function validateReviewedLandXmlEntry(entry, index, errors) {
  const where = `files[${index}]`;
  if (!isObject(entry.provenance)) {
    invalid(errors, `${where}.provenance`, 'is required for a reviewed LandXML fixture');
    return;
  }
  const { provenance } = entry;
  if (!isObject(provenance.source)) {
    invalid(errors, `${where}.provenance.source`, 'is required');
  } else {
    const source = provenance.source;
    if (!isText(source.commit) || !COMMIT_RE.test(source.commit)) {
      invalid(errors, `${where}.provenance.source.commit`, 'must be a 40-character lowercase Git commit');
    }
    requirePinnedGitHubBlobUrl(source.blob_url, source.commit, `${where}.provenance.source.blob_url`, errors);
    if (!isText(source.sha256) || !SHA256_RE.test(source.sha256)) {
      invalid(errors, `${where}.provenance.source.sha256`, 'must be a lowercase SHA-256');
    }
    requireText(source.fetched_at, `${where}.provenance.source.fetched_at`, errors);
    if (isText(source.fetched_at) && Number.isNaN(Date.parse(source.fetched_at))) {
      invalid(errors, `${where}.provenance.source.fetched_at`, 'must be an ISO-8601 date or timestamp');
    }
  }
  if (!isObject(provenance.license)) {
    invalid(errors, `${where}.provenance.license`, 'is required');
  } else {
    requireText(provenance.license.spdx, `${where}.provenance.license.spdx`, errors);
    requireUrl(provenance.license.url, `${where}.provenance.license.url`, errors);
    requireText(provenance.license.attribution, `${where}.provenance.license.attribution`, errors);
  }
  if (!isObject(provenance.modification)) {
    invalid(errors, `${where}.provenance.modification`, 'is required');
  } else {
    const { modification } = provenance;
    if (modification.status !== 'unmodified' && modification.status !== 'modified') {
      invalid(errors, `${where}.provenance.modification.status`, 'must be "unmodified" or "modified"');
    }
    if (modification.status === 'modified') {
      requireText(modification.description, `${where}.provenance.modification.description`, errors);
    }
  }
  if (provenance.no_customer_data !== true) {
    invalid(errors, `${where}.provenance.no_customer_data`, 'must be true after a provenance review');
  }
  if (!isObject(entry.producer)) {
    invalid(errors, `${where}.producer`, 'is required for a reviewed LandXML fixture');
  } else {
    requireText(entry.producer.name, `${where}.producer.name`, errors);
    requireText(entry.producer.version, `${where}.producer.version`, errors);
    requireText(entry.producer.export_settings, `${where}.producer.export_settings`, errors);
  }
  if (!isObject(entry.landxml)) {
    invalid(errors, `${where}.landxml`, 'is required for a reviewed LandXML fixture');
  } else {
    for (const field of ['schema', 'namespace', 'units', 'crs']) {
      requireText(entry.landxml[field], `${where}.landxml.${field}`, errors);
    }
  }
  if (!Array.isArray(entry.feature_inventory) || entry.feature_inventory.length === 0) {
    invalid(errors, `${where}.feature_inventory`, 'must list at least one feature and expected capability');
  } else {
    entry.feature_inventory.forEach((item, itemIndex) => {
      const itemWhere = `${where}.feature_inventory[${itemIndex}]`;
      if (!isObject(item)) {
        invalid(errors, itemWhere, 'must be an object');
        return;
      }
      requireText(item.feature, `${itemWhere}.feature`, errors);
      if (!CAPABILITY_STATES.has(item.expected_capability)) {
        invalid(errors, `${itemWhere}.expected_capability`, `must be one of ${[...CAPABILITY_STATES].join(', ')}`);
      }
    });
  }
  if (provenance.modification?.status === 'unmodified' && provenance.source?.sha256 !== entry.sha256) {
    invalid(errors, `${where}.provenance.source.sha256`, 'must equal entry.sha256 for an unmodified fixture');
  }
}

/** Return human-readable errors without throwing, for CLI callers. */
export function validateManifest(manifest) {
  const errors = [];
  if (!isObject(manifest)) return ['manifest: must be a JSON object'];
  if (manifest.version !== 1 && manifest.version !== 2) {
    invalid(errors, 'manifest.version', 'must be 1 or 2');
  }
  // v1 fetchers historically did not require a release tag when a caller
  // supplied a base URL. Retain that compatibility; v2 needs the tag as part
  // of its reproducible release provenance.
  if (manifest.version === 2) {
    requireText(manifest.release_tag, 'manifest.release_tag', errors);
    requireUrl(manifest.base_url, 'manifest.base_url', errors);
  } else if (manifest.base_url !== undefined) {
    // v1 accepted an environment-provided mirror with no catalogue base URL;
    // retain that contract for existing IFC-only corpora.
    requireText(manifest.base_url, 'manifest.base_url', errors);
  }
  if (!Array.isArray(manifest.files)) {
    invalid(errors, 'manifest.files', 'must be an array');
    return errors;
  }
  manifest.files.forEach((entry, index) => {
    const where = `files[${index}]`;
    if (!isObject(entry)) {
      invalid(errors, where, 'must be an object');
      return;
    }
    requireText(entry.path, `${where}.path`, errors);
    if (!isText(entry.sha256) || !SHA256_RE.test(entry.sha256)) {
      invalid(errors, `${where}.sha256`, 'must be a lowercase SHA-256');
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      invalid(errors, `${where}.size`, 'must be a non-negative safe integer');
    }
    if (entry.upstream_archive !== undefined) {
      const archive = entry.upstream_archive;
      if (!isObject(archive)) {
        invalid(errors, `${where}.upstream_archive`, 'must be an object');
      } else {
        if (!/\.ifc$/i.test(entry.path)) invalid(errors, `${where}.path`, 'upstream ZIP extraction supports IFC files only');
        if (!isText(archive.commit) || !COMMIT_RE.test(archive.commit)) {
          invalid(errors, `${where}.upstream_archive.commit`, 'must be a 40-character lowercase Git commit');
        }
        requirePinnedGitHubBlobUrl(archive.blob_url, archive.commit, `${where}.upstream_archive.blob_url`, errors);
        if (!isText(archive.blob_url) || !/\.zip$/i.test(archive.blob_url)) {
          invalid(errors, `${where}.upstream_archive.blob_url`, 'must name a ZIP archive');
        }
        if (!isText(archive.sha256) || !SHA256_RE.test(archive.sha256)) {
          invalid(errors, `${where}.upstream_archive.sha256`, 'must be a lowercase SHA-256');
        }
        if (!Number.isSafeInteger(archive.size) || archive.size <= 0 || archive.size > 200_000_000) {
          invalid(errors, `${where}.upstream_archive.size`, 'must be a positive archive size of at most 200 MB');
        }
        requireText(archive.member, `${where}.upstream_archive.member`, errors);
      }
    }
    // The root manifest remains v1 while the historical IFC catalogue awaits
    // its own rights review. LandXML files are reviewed per entry, so adding
    // one cannot bypass provenance simply by retaining a v1 root header.
    if (isLandXmlPath(entry.path)) validateReviewedLandXmlEntry(entry, index, errors);
  });
  return errors;
}

export function assertValidManifest(manifest) {
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`invalid fixture manifest:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
}
