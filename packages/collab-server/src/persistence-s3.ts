/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * S3 persistence backend (spec §12.2).
 *
 * Implements the `Persistence` interface against any S3-compatible
 * object store (AWS S3, R2, MinIO, etc.). To keep `@ifc-lite/collab-server`
 * free of a hard `@aws-sdk/client-s3` dependency, this module accepts
 * a tiny `S3Client`-shaped interface that the deployer fulfils — either
 * by passing the real SDK directly (the AWS SDK satisfies the shape) or
 * by writing a thin shim around their preferred storage client.
 *
 * Layout per room:
 *   - `s3://bucket/<prefix><sanitizedRoomId>.snap`        ← compacted state
 *   - `s3://bucket/<prefix><sanitizedRoomId>.log/<n>.bin` ← rolling log frames
 *
 * Compaction overwrites `.snap` and truncates the log directory.
 */

import type { Persistence } from './persistence.js';

/** Minimum S3 surface we need; AWS SDK satisfies it directly. */
export interface S3LikeClient {
  send(command: unknown): Promise<unknown>;
}

export interface S3Commands {
  PutObjectCommand: new (input: PutObjectInput) => unknown;
  GetObjectCommand: new (input: GetObjectInput) => unknown;
  DeleteObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  ListObjectsV2Command: new (input: { Bucket: string; Prefix?: string }) => unknown;
  HeadObjectCommand?: new (input: { Bucket: string; Key: string }) => unknown;
}

export interface PutObjectInput {
  Bucket: string;
  Key: string;
  Body: Uint8Array | Buffer;
  ContentType?: string;
}
export interface GetObjectInput {
  Bucket: string;
  Key: string;
}

export interface S3PersistenceOptions {
  client: S3LikeClient;
  commands: S3Commands;
  bucket: string;
  /** Optional key prefix, e.g. `'collab/'`. Default `''`. */
  prefix?: string;
  /** Frame size cap in bytes per log entry. Default 1 MB. */
  frameMaxBytes?: number;
}

export class S3Persistence implements Persistence {
  private readonly client: S3LikeClient;
  private readonly cmds: S3Commands;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly frameMaxBytes: number;
  /** Per-room counter of next log frame number. */
  private readonly logCounters = new Map<string, number>();

  constructor(opts: S3PersistenceOptions) {
    this.client = opts.client;
    this.cmds = opts.commands;
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ?? '';
    this.frameMaxBytes = opts.frameMaxBytes ?? 1024 * 1024;
  }

  private safeRoom(roomId: string): string {
    return roomId.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private snapKey(roomId: string): string {
    return `${this.prefix}${this.safeRoom(roomId)}.snap`;
  }

  private logKey(roomId: string, n: number): string {
    return `${this.prefix}${this.safeRoom(roomId)}.log/${String(n).padStart(10, '0')}.bin`;
  }

  private async getObjectBytes(key: string): Promise<Uint8Array | null> {
    const Get = this.cmds.GetObjectCommand;
    try {
      const res = await this.client.send(new Get({ Bucket: this.bucket, Key: key }));
      const body = (res as { Body?: { transformToByteArray?: () => Promise<Uint8Array> } }).Body;
      if (body?.transformToByteArray) {
        return await body.transformToByteArray();
      }
      // Stream-shape body: collect chunks.
      if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        return concat(chunks);
      }
      return null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async load(roomId: string): Promise<Uint8Array | null> {
    // Snapshot first, then concatenated log frames after it.
    const snap = await this.getObjectBytes(this.snapKey(roomId));
    const List = this.cmds.ListObjectsV2Command;
    const list = (await this.client.send(
      new List({ Bucket: this.bucket, Prefix: `${this.prefix}${this.safeRoom(roomId)}.log/` }),
    )) as { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean };
    const keys = (list.Contents ?? [])
      .map((c) => c.Key)
      .filter((k): k is string => typeof k === 'string')
      .sort();
    const frames: Uint8Array[] = snap ? [snap] : [];
    for (const key of keys) {
      const bytes = await this.getObjectBytes(key);
      if (bytes) frames.push(bytes);
    }
    if (frames.length === 0) return null;

    // Track the next counter we'll use for appends.
    const lastNum =
      keys.length > 0
        ? Number(keys[keys.length - 1].split('/').pop()?.replace('.bin', '') ?? 0)
        : 0;
    this.logCounters.set(roomId, lastNum + 1);

    return concat(frames);
  }

  async append(roomId: string, update: Uint8Array): Promise<void> {
    if (update.byteLength > this.frameMaxBytes) {
      throw new Error(
        `@ifc-lite/collab-server: frame ${update.byteLength}B exceeds frameMaxBytes ${this.frameMaxBytes}`,
      );
    }
    const next = this.logCounters.get(roomId) ?? 1;
    this.logCounters.set(roomId, next + 1);
    const Put = this.cmds.PutObjectCommand;
    await this.client.send(
      new Put({
        Bucket: this.bucket,
        Key: this.logKey(roomId, next),
        Body: Buffer.from(update),
        ContentType: 'application/octet-stream',
      }),
    );
  }

  async compact(roomId: string, mergedState: Uint8Array): Promise<void> {
    const Put = this.cmds.PutObjectCommand;
    await this.client.send(
      new Put({
        Bucket: this.bucket,
        Key: this.snapKey(roomId),
        Body: Buffer.from(mergedState),
        ContentType: 'application/octet-stream',
      }),
    );
    // Remove all log frames; new ones start at 1.
    await this.removeLog(roomId);
    this.logCounters.set(roomId, 1);
  }

  async drop(roomId: string): Promise<void> {
    const Del = this.cmds.DeleteObjectCommand;
    await Promise.all([
      this.client.send(new Del({ Bucket: this.bucket, Key: this.snapKey(roomId) })).catch(swallowNotFound),
      this.removeLog(roomId),
    ]);
    this.logCounters.delete(roomId);
  }

  private async removeLog(roomId: string): Promise<void> {
    const List = this.cmds.ListObjectsV2Command;
    const Del = this.cmds.DeleteObjectCommand;
    const list = (await this.client.send(
      new List({ Bucket: this.bucket, Prefix: `${this.prefix}${this.safeRoom(roomId)}.log/` }),
    )) as { Contents?: Array<{ Key?: string }> };
    const keys = (list.Contents ?? []).map((c) => c.Key).filter((k): k is string => typeof k === 'string');
    await Promise.all(
      keys.map((k) =>
        this.client.send(new Del({ Bucket: this.bucket, Key: k })).catch(swallowNotFound),
      ),
    );
  }
}

function concat(arr: Uint8Array[]): Uint8Array {
  const total = arr.reduce((n, a) => n + a.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arr) {
    out.set(a, o);
    o += a.byteLength;
  }
  return out;
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey') return true;
  if (e.$metadata?.httpStatusCode === 404) return true;
  return false;
}

function swallowNotFound(err: unknown): void {
  if (isNotFound(err)) return;
  throw err;
}
