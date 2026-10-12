/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { GithubIssues, publicIssueBody } from "../src/github.js";
import type { Config } from "../src/config.js";
import type { ReportRow } from "../src/reports.js";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: Config = {
  origin: "https://viewer.example.com",
  port: 0,
  databaseUrl: "unused",
  bucket: "unused",
  region: "unused",
  accessKeyId: "unused",
  secretAccessKey: "unused",
  admissionSecret: "unused",
  adminToken: "unused",
  githubAppId: "123",
  githubInstallationId: "456",
  githubPrivateKey: keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
  githubRepository: "owner/repo",
  storageProvider: "test",
  storageLocation: "test",
  backupDisclosure: "none",
  agreement: {
    version: "draft",
    sha256: "",
    text: "",
    issuer: "LTplus AG",
    jurisdiction: "Switzerland",
    signingEnabled: false,
  },
  maxDailyReports: 1,
  maxDailyBytes: 1,
  maxStorageBytes: 1,
};
function report(id: string): ReportRow {
  return {
    id,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 86400000),
    session_id: "owner",
    draft: {
      clientRequestId: id,
      title: "Reviewed report",
      description: `Evidence for ${id}`,
      diagnostics: {
        errorCode: "generic_error",
        appVersion: "1",
        buildSha: "abc",
      },
      visibility: "private",
    },
    status: "submitted",
    agreement: null,
    custom_nda: null,
    issue_url: null,
    fingerprint: `fingerprint-${id}`,
  };
}
function parsedUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
}
describe("#7495 GitHub App transport and ambiguity recovery", () => {
  it("does not disclose attachment names or signed agreement identities in GitHub", () => {
    const row: ReportRow = {
      id: "report",
      created_at: new Date(),
      expires_at: new Date(Date.now() + 86400000),
      session_id: "owner",
      status: "draft",
      issue_url: null,
      draft: {
        clientRequestId: "125be751-2d65-4323-8f52-030926151929",
        title: "Error",
        description: "Reviewed description",
        diagnostics: { errorCode: "camera", appVersion: "1", buildSha: "abc" },
        visibility: "private",
      },
      fingerprint: "fingerprint",
      agreement: { signerEmail: "private@example.com" },
      custom_nda: null,
    };
    const text = publicIssueBody(row);
    expect(text).toContain("Reviewed description");
    expect(text).toContain("ifclite-report:report");
    expect(text).not.toContain("private@example.com");
  });
  it("authenticates App JWT and reconciles a create whose response was lost without duplicating issue", async () => {
    const item = report("report-one");
    let saved: Record<string, unknown> | undefined;
    let creates = 0;
    const transport: typeof fetch = async (input, init) => {
      const url = parsedUrl(input);
      if (url.pathname === "/app/installations/456/access_tokens") {
        expect(init?.method).toBe("POST");
        const auth = new Headers(init?.headers).get("Authorization")!;
        const jwt = auth.slice(7).split(".");
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${jwt[0]}.${jwt[1]}`),
            keys.publicKey,
            Buffer.from(jwt[2]!, "base64url"),
          ),
        ).toBe(true);
        expect(
          JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()).iss,
        ).toBe("123");
        return Response.json({ token: "installation-token" });
      }
      expect(url.pathname).toBe("/repos/owner/repo/issues");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer installation-token",
      );
      if (init?.method === "POST") {
        creates++;
        saved = JSON.parse(String(init.body));
        expect(saved).toMatchObject({ title: item.draft.title });
        expect(String(saved?.body)).toContain(item.draft.description);
        throw new TypeError("network response lost after creation");
      }
      return Response.json(
        saved
          ? [
              {
                ...saved,
                html_url: "https://github.com/owner/repo/issues/10",
                created_at: new Date().toISOString(),
                performed_via_github_app: { id: 123 },
              },
            ]
          : [],
      );
    };
    const github = new GithubIssues(config, transport);
    await expect(github.findOrCreate(item)).rejects.toThrow("response lost");
    expect(await github.findOrCreate(item)).toBe(
      "https://github.com/owner/repo/issues/10",
    );
    expect(creates).toBe(1);
  });
  it("does not accept a marker forged by another App or collapse another reviewed report", async () => {
    const first = report("first");
    const second = report("second");
    const bodies: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = parsedUrl(input);
      if (url.pathname.includes("/access_tokens"))
        return Response.json({ token: "token" });
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        bodies.push(payload.body);
        return Response.json({
          html_url: `https://github.com/owner/repo/issues/${bodies.length}`,
        });
      }
      return Response.json([
        {
          body: `<!-- ifclite-error:${first.fingerprint} -->`,
          created_at: new Date().toISOString(),
          performed_via_github_app: { id: 999 },
          html_url: "https://github.com/owner/repo/issues/forged",
        },
      ]);
    };
    const github = new GithubIssues(config, transport);
    await github.findOrCreate(first);
    await github.findOrCreate(second);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("Evidence for first");
    expect(bodies[1]).toContain("Evidence for second");
  });
});
