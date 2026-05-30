/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {
  startCollabServer,
  FilePersistence,
  MemoryPersistence,
  type StartCollabServerOptions,
  type CollabServerHandle,
} from './server.js';
export {
  type Persistence,
  type FilePersistenceOptions,
} from './persistence.js';
export {
  S3Persistence,
  type S3PersistenceOptions,
  type S3LikeClient,
  type S3Commands,
} from './persistence-s3.js';
export {
  RedisPersistence,
  type RedisPersistenceOptions,
  type RedisLikeClient,
} from './persistence-redis.js';
export {
  type AuthenticateFn,
  type Principal,
  type Role,
  allowAnonymousEditor,
  denyAll,
  canWrite,
} from './auth.js';
export {
  Room,
  RoomManager,
  type RoomOptions,
  type RoomManagerOptions,
  type PeerConnection,
} from './room-manager.js';
export {
  MemoryAuditSink,
  JsonlFileAuditSink,
  noopAuditSink,
  shortHash,
  type AuditEntry,
  type AuditOpType,
  type AuditSink,
  type JsonlFileAuditSinkOptions,
} from './audit-log.js';
export {
  DEFAULT_RETENTION,
  applyRetention,
  planRetention,
  type RetentionDecision,
  type RetentionPolicy,
} from './retention.js';
export {
  SnapshotWorker,
  type SnapshotWorkerOptions,
  type SnapshotResult,
} from './snapshot-worker.js';
export {
  MetricsRegistry,
  defaultMetrics,
  type LabelValues,
} from './metrics.js';
export {
  computeHmac,
  createReplayProtector,
  decodeSignedFrame,
  encodeSignedFrame,
  verifyWithReplayProtector,
  type ReplayDecision,
  type ReplayProtector,
  type ReplayProtectorOptions,
  type UpdateEnvelope,
} from './replay-protect.js';
export {
  type VerifyDecision,
  type VerifyMessageFn,
} from './room-manager.js';
export {
  applySecurityHeaders,
  createSecureHttpServer,
  secureHttpHandler,
  type SecureHttpServerOptions,
} from './secure-server.js';
export {
  startSecureCollabServer,
  type StartSecureCollabServerOptions,
} from './secure-bundle.js';
export {
  createPathLockRegistry,
  harvestUpdatePaths,
  verifyAgainstPathLocks,
  type PathLock,
  type PathLockRegistry,
} from './path-locks.js';
export {
  createRateLimiter,
  type RateLimitOptions,
  type RateLimiter,
} from './rate-limit.js';
export {
  InMemoryBlobStorage,
  handleBlobRequest,
  type ServerBlobStorage,
  type ServerBlobMeta,
  type BlobRouteOptions,
} from './blob-route.js';
export {
  signRoomToken,
  verifyRoomToken,
  createRoomTokenAuthenticator,
  handleTokenMintRequest,
  type RoomTokenClaims,
  type SecretResolver,
  type SignRoomTokenOptions,
  type VerifyRoomTokenOptions,
  type RoomTokenAuthenticatorOptions,
  type TokenEndpointOptions,
  type MintRequestBody,
} from './room-token.js';
