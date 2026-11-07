/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface BimcollabSession {
  readonly spaceGuid: string;
  readonly spaceLabel: string;
  getAccessToken(): Promise<string>;
}
interface ProjectPhase { projectPhaseId: string; name: string }
interface Project { projectId: string; name: string; projectPhases?: ProjectPhase[] | null }
interface Location { locationId: string; name: string; projects?: Project[] | null }
export interface Structure { locations?: Location[] | null }
export interface Version {
  documentVersionId: string;
  documentId: string;
  versionNumber?: string | null;
  versionDate?: string | null;
  modifiedDate?: string | null;
  fileName?: string | null;
}
export interface Document {
  documentId: string;
  documentNumber?: string | null;
  archived?: boolean;
  confidential?: boolean;
  modifiedDate?: string | null;
  latestVersion?: Version | null;
}
export interface IndexRecord {
  documentId: number;
  documentNumber: string;
  versionNumber: string;
  versionId: number;
  fileName: string;
  allowDownload: boolean;
  locationId: number;
  locationName: string;
  projectId: number | null;
  projectName: string | null;
  projectPhaseName: string | null;
}
