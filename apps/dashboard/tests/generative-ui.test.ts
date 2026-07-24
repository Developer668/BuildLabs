import { describe, expect, it } from "vitest";

import {
  GenerativeUiDocumentSchema,
  parseGenerativeUiDocument,
  parseGenerativeUiNode,
} from "../lib/contracts/generative-ui";
import { UnsafeProjectionError } from "../lib/contracts/safety";

describe("typed generative UI registry", () => {
  it("accepts only the explicit component registry", () => {
    const document = parseGenerativeUiDocument({
      schemaVersion: 1,
      nodes: [
        {
          component: "contract",
          props: {
            version: 2,
            title: "Appointment workspace",
            summary: "A bounded appointment request workflow",
            hardRequirements: ["Keyboard accessible form controls"],
            preferences: ["Calm visual treatment"],
          },
        },
        {
          component: "payment",
          props: {
            proposalVersion: 2,
            state: "verified",
            amountLabel: "Paid for proposal version 2",
            actionUrl: null,
          },
        },
        {
          component: "candidates",
          props: {
            contractVersion: 2,
            builders: [
              {
                builderId: "bld_aaaaaaaaaaaaaaaaaaaaaa",
                displayName: "Builder 1",
                status: "running",
                stage: "verifying",
                action: "Verifying configured requirements",
              },
            ],
          },
        },
        {
          component: "verifiers",
          props: {
            contractVersion: 2,
            checks: [
              {
                kind: "build",
                status: "pass",
                scope: "Clean application build",
                completedAt: "2026-07-24T16:00:00.000Z",
              },
            ],
          },
        },
        {
          component: "findings",
          props: {
            state: "clean",
            critical: 0,
            high: 0,
            medium: 0,
            low: 0,
            summaries: [],
          },
        },
        {
          component: "preview",
          props: {
            state: "ready",
            contractVersion: 2,
            artifactDigest:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            url: "https://preview.example.invalid/v2",
            frozen: true,
          },
        },
        {
          component: "deployment",
          props: {
            state: "current",
            contractVersion: 2,
            artifactDigest:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            imageDigest:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            releaseVersion: 2,
            url: "https://release.example.invalid/",
          },
        },
        {
          component: "delivery",
          props: {
            state: "settled",
            releaseVersion: 2,
            channel: "dashboard",
            summary: "Verified production release is available",
          },
        },
      ],
    });

    expect(GenerativeUiDocumentSchema.parse(document).nodes).toHaveLength(8);
  });

  it("rejects unknown components and arbitrary HTML renderers", () => {
    expect(() =>
      parseGenerativeUiNode({
        component: "raw_html",
        props: { html: "<button>Deploy</button>" },
      }),
    ).toThrow(UnsafeProjectionError);

    expect(() =>
      parseGenerativeUiNode({
        component: "mcp_app",
        props: { server: "privileged-provider" },
      }),
    ).toThrow(UnsafeProjectionError);
  });

  it("rejects unsafe text and URLs", () => {
    expect(() =>
      parseGenerativeUiNode({
        component: "delivery",
        props: {
          state: "settled",
          releaseVersion: 2,
          channel: "dashboard",
          summary: "<script>alert(1)</script>",
        },
      }),
    ).toThrow(UnsafeProjectionError);

    for (const url of [
      "javascript:alert(1)",
      "http://preview.example.invalid/",
      "https://user:pass@preview.example.invalid/",
      "https://preview.example.invalid/#token",
    ]) {
      expect(() =>
        parseGenerativeUiNode({
          component: "preview",
          props: {
            state: "ready",
            contractVersion: 2,
            artifactDigest:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            url,
            frozen: true,
          },
        }),
      ).toThrow(UnsafeProjectionError);
    }
  });

  it("rejects mutable preview URLs and raw provider metadata", () => {
    expect(() =>
      parseGenerativeUiNode({
        component: "preview",
        props: {
          state: "ready",
          contractVersion: 2,
          artifactDigest:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          url: "https://preview.example.invalid/v2",
          frozen: false,
        },
      }),
    ).toThrow(UnsafeProjectionError);

    expect(() =>
      parseGenerativeUiNode({
        component: "candidates",
        props: {
          contractVersion: 2,
          builders: [],
          providerId: "daytona-sandbox-123",
        },
      }),
    ).toThrow(UnsafeProjectionError);
  });
});
