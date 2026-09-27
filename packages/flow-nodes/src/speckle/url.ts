/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which Speckle object graph a `speckle.receive` node reads, parsed from the
 * URL a user copies out of the Speckle web app. Three shapes are accepted:
 *
 *   https://<server>/projects/<project>/models/<model>             latest version of a model
 *   https://<server>/projects/<project>/models/<model>@<version>   one pinned version
 *   https://<server>/streams/<stream>/commits/<commit>             legacy (v2) commit = version
 *   https://<server>/streams/<stream>/objects/<object>             legacy (v2) object, no version lookup
 *
 * A stream id and a project id are the same identifier (the v2 → v3 rename),
 * so both resolve to `projectId`. A federated view (`models/a,b`) names
 * several models at once; it is refused rather than silently narrowed to the
 * first one.
 *
 * Protocol handling in this directory is adapted, as new code, from the
 * author's own ifc-ai-rendering project (`lib/speckle-loader.ts`), at the
 * author's request.
 */

export type SpeckleTarget =
  | {
      readonly kind: 'version';
      readonly server: string;
      readonly projectId: string;
      /** Absent for a legacy commit URL: a version is addressable by id alone. */
      readonly modelId?: string;
      /** Absent: the model's latest version. */
      readonly versionId?: string;
    }
  | { readonly kind: 'object'; readonly server: string; readonly projectId: string; readonly objectId: string };

const SEGMENT = /^[A-Za-z0-9_-]+$/;

function segment(value: string | undefined, what: string, url: string): string {
  const v = value === undefined ? '' : decodeURIComponent(value);
  if (!SEGMENT.test(v)) throw new Error(`speckle.receive: "${url}" has no usable ${what}`);
  return v;
}

/** Parse a Speckle URL. Throws, naming the URL, on anything it cannot address. */
export function parseSpeckleUrl(raw: string): SpeckleTarget {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('speckle.receive: "url" is required');
  // A bare host/path is read as https; an explicit other scheme is kept so the
  // network gate refuses it by name rather than this parser rewriting it.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`speckle.receive: "${raw}" is not a valid URL`);
  }
  const server = `${url.protocol}//${url.host}`;
  const parts = url.pathname.split('/').filter((p) => p.length > 0);

  if (parts[0] === 'projects' && parts[2] === 'models') {
    const projectId = segment(parts[1], 'project id', raw);
    const modelPart = parts[3] ?? '';
    if (modelPart.includes(',')) {
      throw new Error(`speckle.receive: "${raw}" names several models (a federated view); receive one model per node`);
    }
    const [model, version] = modelPart.split('@');
    const modelId = segment(model, 'model id', raw);
    const versionId = version === undefined ? undefined : segment(version, 'version id', raw);
    return { kind: 'version', server, projectId, modelId, versionId };
  }
  if (parts[0] === 'streams' && parts[2] === 'commits') {
    return { kind: 'version', server, projectId: segment(parts[1], 'stream id', raw), versionId: segment(parts[3], 'commit id', raw) };
  }
  if (parts[0] === 'streams' && parts[2] === 'objects') {
    return { kind: 'object', server, projectId: segment(parts[1], 'stream id', raw), objectId: segment(parts[3], 'object id', raw) };
  }
  throw new Error(
    `speckle.receive: "${raw}" is not a Speckle model, version, commit or object URL ` +
      '(expected /projects/<project>/models/<model>[@<version>], /streams/<stream>/commits/<commit> or /streams/<stream>/objects/<object>)',
  );
}
