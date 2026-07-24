/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Minimal, hand-rolled Microsoft Graph v1.0 response shapes — only the
// fields this provider actually reads. Not a generated client: Graph's full
// schema is enormous, and every field here is one the verified API facts in
// the task brief called out.
// ============================================================================

export interface GraphPage<T> {
  readonly value: readonly T[];
  readonly '@odata.nextLink'?: string;
  readonly '@odata.deltaLink'?: string;
}

export interface GraphIdentity {
  readonly id?: string;
  readonly displayName?: string;
}

export interface GraphIdentitySet {
  readonly user?: GraphIdentity;
  readonly application?: GraphIdentity;
}

export interface GraphFileFacet {
  readonly mimeType?: string;
  readonly hashes?: Record<string, string>;
}

export interface GraphFolderFacet {
  readonly childCount?: number;
}

export interface GraphDeletedFacet {
  readonly state?: string;
}

export interface GraphDriveItem {
  readonly id: string;
  readonly name?: string;
  readonly size?: number;
  readonly cTag?: string;
  readonly eTag?: string;
  readonly lastModifiedDateTime?: string;
  readonly lastModifiedBy?: GraphIdentitySet;
  readonly file?: GraphFileFacet;
  readonly folder?: GraphFolderFacet;
  readonly deleted?: GraphDeletedFacet;
  readonly parentReference?: { readonly driveId?: string; readonly id?: string };
  readonly '@microsoft.graph.downloadUrl'?: string;
}

export interface GraphDrive {
  readonly id: string;
  readonly name?: string;
  readonly driveType?: string;
}

export interface GraphSite {
  readonly id: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly webUrl?: string;
}

export interface GraphDriveItemVersion {
  readonly id: string;
  readonly lastModifiedDateTime?: string;
  readonly lastModifiedBy?: GraphIdentitySet;
  readonly size?: number;
}

export interface GraphUser {
  readonly id: string;
  readonly displayName?: string;
  readonly mail?: string;
  readonly userPrincipalName?: string;
}

export function isFolder(item: GraphDriveItem): boolean {
  return item.folder !== undefined;
}

export function isFile(item: GraphDriveItem): boolean {
  return item.file !== undefined;
}
