/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bounds on everything a tile file can make the reader allocate. Tileset URLs
 * are user input in the browser, the CLI and the MCP server, so every count,
 * length and offset taken from a file is checked against the bytes actually
 * present, or against one of these budgets, before anything is allocated.
 */

/** Machine-readable reason attached to a `ReaderIssue`. */
export type ReaderIssueCode =
  /** A declared count or size exceeds a decode budget or what the bytes can hold. */
  | 'limit'
  /** The content is malformed (negative offset, stride shorter than an element, float indices, ...). */
  | 'invalid-content'
  /** A URL was refused by the URL policy (`allowedProtocols` / `allowedOrigins`). */
  | 'url-policy'
  /** Expected attribute columns are absent (swisstopo preset). */
  | 'missing-attributes';

/** Thrown by content decoding for input that is refused rather than read; becomes a typed issue. */
export class ContentRejectedError extends Error {
  constructor(readonly code: 'limit' | 'invalid-content', message: string) {
    super(message);
    this.name = 'ContentRejectedError';
  }
}

export const invalid = (message: string): ContentRejectedError => new ContentRejectedError('invalid-content', message);
export const tooLarge = (message: string): ContentRejectedError => new ContentRejectedError('limit', message);

export interface DecodeLimits {
  /**
   * Decoded vertices one tile content may produce (each glTF node instance of
   * a primitive counts again). Default 2,000,000.
   */
  maxVerticesPerContent?: number;
  /** Triangle indices one tile content may produce. Default 6,000,000. */
  maxIndicesPerContent?: number;
  /** Decoded vertices across the whole query. Default 8,000,000. */
  maxDecodedVertices?: number;
  /** Triangle indices across the whole query. Default 24,000,000. */
  maxDecodedIndices?: number;
}

export const DEFAULT_DECODE_LIMITS: Required<DecodeLimits> = {
  maxVerticesPerContent: 2_000_000,
  maxIndicesPerContent: 6_000_000,
  maxDecodedVertices: 8_000_000,
  maxDecodedIndices: 24_000_000,
};

/** Thrown when a decode budget is exceeded; `scope` says which one. */
export class DecodeLimitError extends Error {
  constructor(readonly scope: 'content' | 'total', message: string) {
    super(message);
    this.name = 'DecodeLimitError';
  }
}

/** A budget or bound: undefined takes the default; NaN, negatives and non-numbers throw (Infinity means unbounded). */
export function limit(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || Number.isNaN(v) || v < 0) throw new RangeError(`${name} must be a non-negative number`);
  return v;
}

/** A count that must be at least 1 and whole, e.g. a worker count. */
export function positiveInteger(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer`);
  return v;
}

/** A finite number of at least `min` (and at most `max` when given). */
export function finiteNumber(v: number | undefined, fallback: number, name: string, min: number, max = Infinity): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new RangeError(`${name} must be a finite number${max === Infinity ? ` >= ${min}` : ` in [${min}, ${max}]`}`);
  }
  return v;
}

/** Decoded vertex and index budget for one query, shared by every content. */
export class DecodeBudget {
  readonly limits: Required<DecodeLimits>;
  vertices = 0;
  indices = 0;

  constructor(opts: DecodeLimits = {}) {
    this.limits = {
      maxVerticesPerContent: limit(opts.maxVerticesPerContent, DEFAULT_DECODE_LIMITS.maxVerticesPerContent, 'maxVerticesPerContent'),
      maxIndicesPerContent: limit(opts.maxIndicesPerContent, DEFAULT_DECODE_LIMITS.maxIndicesPerContent, 'maxIndicesPerContent'),
      maxDecodedVertices: limit(opts.maxDecodedVertices, DEFAULT_DECODE_LIMITS.maxDecodedVertices, 'maxDecodedVertices'),
      maxDecodedIndices: limit(opts.maxDecodedIndices, DEFAULT_DECODE_LIMITS.maxDecodedIndices, 'maxDecodedIndices'),
    };
  }

  /** True once the query-wide budget has no room left. */
  exhausted(): boolean {
    return this.vertices >= this.limits.maxDecodedVertices || this.indices >= this.limits.maxDecodedIndices;
  }

  forContent(): ContentBudget {
    return new ContentBudget(this);
  }
}

/** One content's share of the query budget; `release()` returns it when the content is dropped. */
export class ContentBudget {
  vertices = 0;
  indices = 0;

  constructor(private readonly total: DecodeBudget) {}

  get maxVertices(): number {
    return this.total.limits.maxVerticesPerContent;
  }

  get maxIndices(): number {
    return this.total.limits.maxIndicesPerContent;
  }

  /** Reserve `vertices` and `indices` before they are decoded; throws without reserving when either budget would be exceeded. */
  charge(vertices: number, indices: number, what: string): void {
    const L = this.total.limits;
    if (this.vertices + vertices > L.maxVerticesPerContent || this.indices + indices > L.maxIndicesPerContent) {
      throw new DecodeLimitError('content', `${what}: ${this.vertices + vertices} vertices / ${this.indices + indices} indices exceed the per-content limit (${L.maxVerticesPerContent} / ${L.maxIndicesPerContent})`);
    }
    if (this.total.vertices + vertices > L.maxDecodedVertices || this.total.indices + indices > L.maxDecodedIndices) {
      throw new DecodeLimitError('total', `${what}: the query's decoded vertex/index budget (${L.maxDecodedVertices} / ${L.maxDecodedIndices}) is exhausted`);
    }
    this.vertices += vertices;
    this.indices += indices;
    this.total.vertices += vertices;
    this.total.indices += indices;
  }

  release(): void {
    this.total.vertices -= this.vertices;
    this.total.indices -= this.indices;
    this.vertices = 0;
    this.indices = 0;
  }
}
