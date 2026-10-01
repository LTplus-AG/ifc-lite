/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Adapted from GeoBIM's MPL-2.0 IFC upload, release geobim-2026-09-24.
 * Contract: https://ion.cesium.com/openapi.yaml (BimCadOptions).
 * Embedded IFC georeferencing takes precedence over position; heading is not
 * a documented option. A successful upload starts tiling, it does not finish it.
 */
const API = 'https://api.cesium.com/v1';
export type IonUploadPhase = 'create' | 'upload' | 'complete';
export class IonUploadError extends Error {
  constructor(readonly phase: IonUploadPhase, readonly assetId?: number, readonly status?: number) {
    super(`Cesium ion ${phase} failed${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'IonUploadError';
  }
}
export function ionAssetUrl(assetId: number): string {
  return `https://ion.cesium.com/assets/${assetId}`;
}
export interface IonUploadInput {
  token: string;
  name: string;
  fileName: string;
  bytes: Uint8Array;
  signal: AbortSignal;
  onPhase?: (phase: IonUploadPhase) => void;
}
interface UploadLocation {
  endpoint?: string;
  bucket: string;
  prefix: string;
  accessKey: string;
  secretAccessKey: string;
  sessionToken: string;
}
export interface IonS3Request {
  location: UploadLocation;
  key: string;
  bytes: Uint8Array;
  signal: AbortSignal;
}
export interface IonUploadDeps {
  fetchImpl?: typeof fetch;
  putObject?: (input: IonS3Request) => Promise<void>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ion response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid ion response');
  return value;
}
function location(value: unknown): UploadLocation {
  const data = object(value);
  const endpoint = data.endpoint === undefined ? undefined : text(data.endpoint);
  if (endpoint) {
    const url = new URL(endpoint);
    const trusted = url.hostname === 'ion.cesium.com' || url.hostname.endsWith('.ion.cesium.com')
      || url.hostname.endsWith('.amazonaws.com');
    if (url.protocol !== 'https:' || url.username || url.password || !trusted) throw new Error('Invalid ion storage endpoint');
  }
  return {
    endpoint, bucket: text(data.bucket), prefix: text(data.prefix),
    accessKey: text(data.accessKey), secretAccessKey: text(data.secretAccessKey), sessionToken: text(data.sessionToken),
  };
}
async function putObject(input: IonS3Request): Promise<void> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  input.signal.throwIfAborted();
  const client = new S3Client({
    region: 'us-east-1', endpoint: input.location.endpoint, forcePathStyle: true,
    credentials: {
      accessKeyId: input.location.accessKey,
      secretAccessKey: input.location.secretAccessKey,
      sessionToken: input.location.sessionToken,
    },
  });
  try {
    await client.send(new PutObjectCommand({
      Bucket: input.location.bucket, Key: input.key, Body: input.bytes,
      ContentType: 'application/octet-stream',
    }), { abortSignal: input.signal });
  } finally {
    client.destroy();
  }
}

export async function uploadToCesiumIon(input: IonUploadInput, deps: IonUploadDeps = {}): Promise<{ assetId: number }> {
  input.signal.throwIfAborted();
  if (!input.token.trim() || !input.name.trim() || !input.bytes.length
    || !/^[^/\\\u0000-\u001f\u007f]+\.ifc$/i.test(input.fileName)) {
    throw new IonUploadError('create');
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${input.token.trim()}`, 'Content-Type': 'application/json' };
  let phase: IonUploadPhase = 'create';
  let assetId: number | undefined;
  try {
    input.onPhase?.(phase);
    const created = await fetchImpl(`${API}/assets`, {
      method: 'POST', headers, redirect: 'error', signal: input.signal,
      body: JSON.stringify({ name: input.name.trim(), type: '3DTILES', options: { sourceType: 'BIM_CAD' } }),
    });
    if (!created.ok) throw new IonUploadError(phase, assetId, created.status);
    const response = object(await created.json());
    const id = object(response.assetMetadata).id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid asset id');
    assetId = id;
    const uploadLocation = location(response.uploadLocation);
    const completion = object(response.onComplete);
    const url = new URL(text(completion.url));
    if (url.origin !== new URL(API).origin || url.username || url.password
      || url.pathname !== `/v1/assets/${id}/uploadComplete` || completion.method !== 'POST') {
      throw new Error('Invalid ion completion instruction');
    }
    const fields = object(completion.fields);
    phase = 'upload';
    input.onPhase?.(phase);
    input.signal.throwIfAborted();
    await (deps.putObject ?? putObject)({
      location: uploadLocation, key: `${uploadLocation.prefix}${input.fileName}`,
      bytes: input.bytes, signal: input.signal,
    });
    phase = 'complete';
    input.onPhase?.(phase);
    input.signal.throwIfAborted();
    const completed = await fetchImpl(url.href, {
      method: 'POST', headers, redirect: 'error', signal: input.signal, body: JSON.stringify(fields),
    });
    if (!completed.ok) throw new IonUploadError(phase, assetId, completed.status);
    return { assetId };
  } catch (error) {
    // Never expose arbitrary server/SDK text, which may echo credentials.
    if (error instanceof IonUploadError) throw error;
    throw new IonUploadError(phase, assetId);
  }
}
