/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { loadJournalConfig, type JournalConfig } from "./journal-config.js";
import { createHash } from "node:crypto";
import { trustedProxyList } from "./admission.js";
import { readFileSync } from "node:fs";
import type { ReportAgreement } from "@ifc-lite/report-contract";
export interface Config {
  submissionsEnabled: boolean;
  journal?: JournalConfig;
  /** Deliberately absent from loadConfig until the scanner/delivery deployment is qualified. */
  publicSharing?: {
    scannerImageDigest: string;
    maxDailyDownloadBytes: number;
    maxConcurrentDownloads: number;
  };
  qualificationToken?: string;
  posthog?: { host: string; projectId: string; apiKey: string };
  trustedProxyCidrs?: string[];
  agreementFont?: Uint8Array;
  storageProvider: string;
  storageLocation: string;
  backupDisclosure: string;
  origin: string;
  port: number;
  databaseUrl: string;
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  admissionSecret: string;
  adminToken: string;
  githubAppId: string;
  githubInstallationId: string;
  githubPrivateKey: string;
  githubRepository: string;
  agreement: ReportAgreement;
  maxDailyReports: number;
  maxDailyBytes: number;
  maxStorageBytes: number;
}
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const origin = required("REPORT_VIEWER_ORIGIN");
  if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
    throw new Error("REPORT_VIEWER_ORIGIN must be an exact HTTPS origin");
  const hasPosthog = [env.REPORT_POSTHOG_HOST, env.REPORT_POSTHOG_PROJECT_ID, env.REPORT_POSTHOG_API_KEY].some(Boolean);
  const posthog = hasPosthog ? { host: required("REPORT_POSTHOG_HOST"), projectId: required("REPORT_POSTHOG_PROJECT_ID"), apiKey: required("REPORT_POSTHOG_API_KEY") } : undefined;
  if (posthog && (!["https://eu.posthog.com", "https://us.posthog.com", "https://app.posthog.com"].includes(posthog.host) || !/^\d+$/.test(posthog.projectId)))
    throw new Error("REPORT_POSTHOG_HOST/project must identify the configured PostHog Cloud project");
  const text = env.REPORT_AGREEMENT_FILE
    ? readFileSync(env.REPORT_AGREEMENT_FILE, "utf8")
    : "";
  const sha256 = createHash("sha256").update(text).digest("hex");
  const approval = env.REPORT_APPROVED_AGREEMENT_SHA256;
  if (
    approval &&
    (!text ||
      approval !== sha256 ||
      /\[\[|\{\{|TODO|DRAFT|PLACEHOLDER/i.test(text))
  )
    throw new Error(
      "Approved agreement does not match a complete, non-draft template",
    );
  const version = env.REPORT_AGREEMENT_VERSION?.trim() || "unapproved";
  if (
    approval &&
    (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(version) ||
      /^(unapproved|draft|placeholder|todo)(?:$|[._-])/i.test(version))
  )
    throw new Error(
      "REPORT_AGREEMENT_VERSION must identify the approved agreement version",
    );
  if (approval) {
    const declarations = [...text.matchAll(/^Agreement version:([^\r\n]*)$/gm)];
    if (declarations.length !== 1 || declarations[0]?.[1]?.trim() !== version)
      throw new Error(
        "Approved agreement version declaration must match REPORT_AGREEMENT_VERSION",
      );
  }
  const secret = required("REPORT_ADMISSION_SECRET");
  const adminToken = required("REPORT_ADMIN_TOKEN");
  if (secret.length < 32 || adminToken.length < 32)
    throw new Error("Report secrets must have at least 32 characters");
  const qualificationToken = env.REPORT_QUALIFICATION_TOKEN?.trim();
  if (
    qualificationToken &&
    (qualificationToken.length < 32 ||
      qualificationToken === secret ||
      qualificationToken === adminToken)
  )
    throw new Error(
      "REPORT_QUALIFICATION_TOKEN must be a separate secret of at least 32 characters",
    );
  const inlineKey = env.REPORT_GITHUB_PRIVATE_KEY;
  const keyFile = env.REPORT_GITHUB_PRIVATE_KEY_FILE?.trim();
  if (Boolean(inlineKey?.trim()) === Boolean(keyFile))
    throw new Error(
      "Configure exactly one of REPORT_GITHUB_PRIVATE_KEY or REPORT_GITHUB_PRIVATE_KEY_FILE",
    );
  const githubPrivateKey = keyFile ? readFileSync(keyFile, "utf8") : inlineKey!;
  if (!githubPrivateKey.trim())
    throw new Error("GitHub App private key is empty");
  const githubRepository = required("REPORT_GITHUB_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepository))
    throw new Error("Invalid GitHub repository");
  const trustedProxyCidrs = (env.REPORT_TRUSTED_PROXY_CIDRS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  trustedProxyList(trustedProxyCidrs);
  return {
    submissionsEnabled: env.REPORT_SUBMISSIONS_ENABLED === "true",
    journal: loadJournalConfig(env),
    qualificationToken,
    trustedProxyCidrs,
    agreementFont: approval
      ? readFileSync(required("REPORT_AGREEMENT_FONT_FILE"))
      : undefined,
    posthog,
    storageProvider: required("REPORT_STORAGE_PROVIDER"),
    storageLocation: required("REPORT_STORAGE_LOCATION"),
    backupDisclosure: required("REPORT_BACKUP_DISCLOSURE"),
    origin,
    port: Number(env.PORT ?? 3005),
    databaseUrl: required("REPORT_DATABASE_URL"),
    bucket: required("REPORT_S3_BUCKET"),
    region: required("REPORT_S3_REGION"),
    endpoint: env.REPORT_S3_ENDPOINT,
    forcePathStyle: env.REPORT_S3_FORCE_PATH_STYLE === "true",
    accessKeyId: required("REPORT_S3_ACCESS_KEY_ID"),
    secretAccessKey: required("REPORT_S3_SECRET_ACCESS_KEY"),
    admissionSecret: secret,
    adminToken,
    githubAppId: required("REPORT_GITHUB_APP_ID"),
    githubInstallationId: required("REPORT_GITHUB_INSTALLATION_ID"),
    githubPrivateKey,
    githubRepository,
    agreement: {
      version,
      sha256,
      text,
      issuer: "LTplus AG",
      jurisdiction: "Switzerland",
      signingEnabled: Boolean(approval),
    },
    maxDailyReports: 20,
    maxDailyBytes: 4 * 1024 ** 3,
    maxStorageBytes: 100 * 1024 ** 3,
  };
}
