/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
const enabled = Boolean(
  process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_S3_ENDPOINT,
);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error("Mandatory real report integration environment is missing");
describe.skipIf(!enabled)(
  "#7498 qualification harness resource shutdown",
  () => {
    for (const phase of ["setup", "cleanup"] as const) {
      it(`closes its real PG pool and exits when ${phase} storage fails`, async () => {
        const temporary = await mkdtemp(
          join(tmpdir(), "report-qualification-"),
        );
        const fixture = join(temporary, "synthetic.ifc");
        await writeFile(
          fixture,
          "ISO-10303-21;\nHEADER;ENDSEC;DATA;ENDSEC;END-ISO-10303-21;",
        );
        let bucket: string | undefined;
        let rejected = 0;
        const upstream = new URL(process.env.REPORT_TEST_S3_ENDPOINT!);
        // Real HTTP proxy forwards actual model traffic and fails only the chosen
        // bucket operation. The child still opens the real PostgreSQL pool.
        const proxy = createServer((req, res) => {
          const path = new URL(req.url!, "http://fixture");
          const segments = path.pathname.split("/").filter(Boolean);
          const bucketOperation = segments.length === 1 && !path.search;
          if (bucketOperation && req.method === "PUT") bucket = segments[0];
          if (
            bucketOperation &&
            req.method === (phase === "setup" ? "PUT" : "DELETE")
          ) {
            rejected++;
            res.writeHead(403, { "Content-Type": "application/xml" });
            res.end(
              "<Error><Code>AccessDenied</Code><Message>Qualification fault</Message></Error>",
            );
            return;
          }
          const forward = httpRequest(
            new URL(req.url!, upstream),
            { method: req.method, headers: req.headers },
            (response) => {
              res.writeHead(response.statusCode!, response.headers);
              response.pipe(res);
            },
          );
          forward.on("error", () => {
            res.writeHead(502);
            res.end();
          });
          req.pipe(forward);
        });
        await new Promise<void>((resolve) =>
          proxy.listen(0, "127.0.0.1", resolve),
        );
        const address = proxy.address();
        if (!address || typeof address === "string")
          throw new Error("Proxy did not bind");
        const root = fileURLToPath(new URL("../../../", import.meta.url));
        const script = fileURLToPath(
          new URL("../scripts/qualify-large-upload.ts", import.meta.url),
        );
        try {
          const result = await new Promise<{
            code: number | null;
            timedOut: boolean;
            output: string;
          }>((resolve) => {
            const child = spawn(
              process.execPath,
              ["--import", "tsx", script, "--fixture", fixture, "--small-only"],
              {
                cwd: root,
                env: {
                  ...process.env,
                  REPORT_TEST_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let timedOut = false;
            let output = "";
            const timer = setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, 7000);
            for (const stream of [child.stdout, child.stderr])
              stream.on("data", (chunk) => {
                output = (output + chunk.toString()).slice(-64000);
              });
            child.on("exit", (code) => {
              clearTimeout(timer);
              resolve({ code, timedOut, output });
            });
          });
          expect(rejected).toBe(1);
          expect(
            result.timedOut,
            "Failed cleanup must not leave the PG pool keeping the process alive",
          ).toBe(false);
          expect(result.code).toBe(1);
          expect(result.output).toContain("AccessDenied");
        } finally {
          proxy.closeAllConnections();
          await new Promise<void>((resolve) => proxy.close(() => resolve()));
          if (phase === "cleanup" && bucket) {
            const client = new S3Client({
              region: "us-east-1",
              endpoint: upstream.toString(),
              forcePathStyle: true,
              credentials: {
                accessKeyId: process.env.REPORT_TEST_S3_ACCESS_KEY_ID!,
                secretAccessKey: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY!,
              },
            });
            try {
              await client.send(new DeleteBucketCommand({ Bucket: bucket }));
            } finally {
              client.destroy();
            }
          }
          await rm(temporary, { recursive: true, force: true });
        }
      }, 20000);
    }
  },
);
