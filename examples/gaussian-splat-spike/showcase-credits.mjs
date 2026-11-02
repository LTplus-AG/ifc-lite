/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567: on-screen credits for licensed showcase captures. The short display
// lines are checked against tests/models/manifest.json, which stays the
// licence record; test/showcase-credits.test.mjs fails if they drift apart.
const LICENSE_NAMES = Object.freeze({ 'CC-BY-4.0': 'CC BY 4.0' });

export const SHOWCASE_SUBJECTS = Object.freeze({
  'gaussian/seem-kirke-v1.ply': Object.freeze({
    title: 'Seem Kirke, Danmark',
    creator: 'Peter Rødsgaard Rasmussen (roedsgaard)',
    attributionMarker: 'Peter Rødsgaard Rasmussen',
    capture: 'Real drone capture',
    pipeline: 'Drone photographs, RealityScan alignment, LichtFeld Studio training',
    change: 'Published quantized SOG converted to PLY; viewpoint changed',
  }),
  'gaussian/delft-aula-library-v1.ply': Object.freeze({
    title: 'Aula & Library, TU Delft',
    creator: 'Yingwen Yu (2025), doi:10.17605/OSF.IO/P3CW7',
    attributionMarker: 'Yu, Y. (2025)',
    capture: 'Real UAV and ground capture',
    pipeline: 'UAV and ground photography, Postshot reconstruction',
    change: 'Unmodified publisher PLY; viewpoint changed',
  }),
});

const bareUrl = url => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Display credits for one manifest entry; throws rather than show an unlicensed capture. */
export function showcaseCredits(entry) {
  const subject = SHOWCASE_SUBJECTS[entry?.path];
  if (!subject) throw new Error(`no showcase credit registered for ${entry?.path}`);
  const license = entry.provenance?.license;
  const licenseName = LICENSE_NAMES[license?.spdx];
  if (!licenseName || !license.url || !license.attribution?.includes(subject.attributionMarker)) {
    throw new Error(`manifest licence record does not support the ${entry.path} credit`);
  }
  const source = entry.provenance.source?.page_url;
  if (!source) throw new Error(`manifest has no source page for ${entry.path}`);
  const status = entry.provenance.modification?.status;
  if ((status === 'modified') !== /converted/i.test(subject.change)) {
    throw new Error(`credit modification note disagrees with manifest status ${status}`);
  }
  return {
    title: subject.title,
    capture: subject.capture,
    pipeline: subject.pipeline,
    credit: `${subject.title} — ${subject.creator} · ${licenseName} · ${bareUrl(source)}`,
    change: `${subject.change} · ${bareUrl(license.url)}`,
    licenseName,
    licenseUrl: license.url,
    sourceUrl: source,
    attribution: license.attribution,
  };
}
