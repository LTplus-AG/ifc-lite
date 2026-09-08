/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A viewpoint's resolved archive file-name components. */
export interface ViewpointFileName {
  /** Full `.bcfv` file name, e.g. `viewpoint.bcfv` or `<guid>_viewpoint.bcfv`. */
  viewpointFile: string;
  /** Snapshot base name WITHOUT extension (extension is per-viewpoint format-detected by `snapshotExt` in writer.ts), e.g. `snapshot` or `<guid>_snapshot`. */
  snapshotBase: string;
}

/**
 * Name a viewpoint's archive files. A topic's FIRST viewpoint gets the
 * conventional names several BCF consumers (e.g. BIMcollab) expect and
 * assume rather than reading from markup.bcf -- `viewpoint.bcfv` /
 * `snapshot.<ext>`. Every ADDITIONAL viewpoint in the same topic keeps a
 * GUID-qualified name, as a SUFFIX (matching BIMcollab's own convention for
 * a topic's non-primary viewpoints) rather than the previous
 * `Viewpoint_<guid>.bcfv` prefix form, so multiple viewpoints in one topic
 * never collide on the plain name (#3612).
 *
 * Takes the already-sanitized per-topic base name (see
 * `sanitizeZipComponent`'s zip-slip guard in writer.ts's `writeTopicFolder`),
 * not the raw GUID, so a hostile GUID can't escape the topic folder here
 * either. Names are scoped per topic folder (`writeTopicFolder`'s
 * `folderName`), so `viewpoint.bcfv` reused across two different topics'
 * first viewpoints does not collide -- they land in different zip
 * directories.
 *
 * `writeTopicFolder` calls this ONCE per viewpoint and threads the result
 * through both the markup `<Viewpoint>`/`<Snapshot>` reference writer
 * (`viewpointXml` in writer.ts) and the archive entry writer
 * (`writeViewpointFiles`), so the two can never disagree on a name.
 */
export function viewpointFileName(baseName: string, index: number): ViewpointFileName {
  if (index === 0) {
    return { viewpointFile: 'viewpoint.bcfv', snapshotBase: 'snapshot' };
  }
  return { viewpointFile: `${baseName}_viewpoint.bcfv`, snapshotBase: `${baseName}_snapshot` };
}
