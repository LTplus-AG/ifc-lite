/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import {
  isDraftInput,
  isUploadInput,
  isAgreementAcceptance,
  REPORT_LIMITS,
} from "./index.js";
const draft = {
  clientRequestId: "125be751-2d65-4323-8f52-030926151929",
  title: "Camera failed",
  description: "After selecting a wall",
  diagnostics: {
    errorCode: "rte_envelope",
    appVersion: "1.0",
    buildSha: "abcdef",
  },
  visibility: "private",
};
describe("#7495 public report boundary", () => {
  it("accepts reviewed diagnostics and rejects extra private model fields", () => {
    expect(isDraftInput(draft)).toBe(true);
    expect(
      isDraftInput({
        ...draft,
        diagnostics: { ...draft.diagnostics, filename: "secret.ifc" },
      }),
    ).toBe(false);
    expect(isDraftInput({ ...draft, model: "bytes" })).toBe(false);
  });
  it("requires explicit upload consent and bounds file size independently of MIME", () => {
    const upload = {
      name: "model.ifc",
      size: 616 * 1024 ** 2,
      type: "application/octet-stream",
      confidentiality: "none",
      uploadConsent: true,
    };
    expect(isUploadInput(upload)).toBe(true);
    expect(isUploadInput({ ...upload, uploadConsent: false })).toBe(false);
    expect(
      isUploadInput({ ...upload, size: REPORT_LIMITS.maxFileBytes + 1 }),
    ).toBe(false);
    expect(isUploadInput({ ...upload, name: "../model.ifc" })).toBe(false);
  });
  it("requires exact digest, authority and acceptance for a standard agreement", () => {
    const acceptance = {
      agreementSha256: "a".repeat(64),
      signerName: "Example Person",
      signerEmail: "person@example.com",
      organization: "Example",
      authorityConfirmed: true,
      accepted: true,
    };
    expect(isAgreementAcceptance(acceptance)).toBe(true);
    expect(
      isAgreementAcceptance({ ...acceptance, authorityConfirmed: false }),
    ).toBe(false);
  });
});
