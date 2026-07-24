import { describe, expect, it } from "vitest";

import { inspectPreview } from "../src/application/preview-inspector.js";
import { sha256 } from "../src/lib/canonical-json.js";
import type {
  RenderedPageInspection,
  SandboxSession,
  TraceSpan,
} from "../src/ports/index.js";
import { assignment } from "./fixtures.js";

describe("preview inspection", () => {
  it("fails hard HTTP evidence when the sandbox browser excludes CSS-hidden text", async () => {
    const html =
      "<style>.proof{display:none}</style><span class=proof>Required</span>";
    const input = assignment("css-hidden-preview");
    const verifier = input.contract.requirements[0]!.verifiers[0]!;
    if (verifier.kind !== "http") {
      throw new Error("Fixture verifier is not HTTP");
    }
    verifier.bodyIncludes = ["Required"];
    const sandbox = new StubRenderedSandbox(() => {
      expect(html).toContain(
        "<style>.proof{display:none}</style><span class=proof>Required</span>",
      );
      return [
        {
          path: "/",
          status: 200,
          visibleText: "",
          screenshotSha256s: ["1".repeat(64)],
        },
      ];
    });

    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "a".repeat(64),
      contract: input.contract,
      sandbox,
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("FAIL");
    expect(result.receipt.checks.at(-1)?.missingText).toEqual(["Required"]);
  });

  it("accepts an unambiguous rendered success result", async () => {
    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "b".repeat(64),
      contract: assignment("rendered-success").contract,
      sandbox: new StubRenderedSandbox((paths) =>
        paths.map((path) => ({
          path,
          status: 200,
          visibleText: "Mission Peak Electric",
          screenshotSha256s: ["2".repeat(64)],
        })),
      ),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("PASS");
    expect(result.pages).toEqual([
      {
        path: "/",
        status: 200,
        visibleText: "Mission Peak Electric",
      },
    ]);
  });

  it("returns bounded screenshot tiles to the controller without persisting bytes", async () => {
    const screenshot = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
    const encoded = screenshot.toString("base64");
    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "2".repeat(64),
      contract: assignment("rendered-controller-screenshot").contract,
      sandbox: new StubRenderedSandbox((paths) =>
        paths.map((path) => ({
          path,
          status: 200,
          visibleText: "Mission Peak Electric",
          screenshotSha256s: [sha256(screenshot)],
          screenshotBase64s: [encoded],
        })),
      ),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.pages[0]?.screenshotBase64s).toEqual([encoded]);
    expect(result.receipt.checks[0]?.screenshotSha256s).toEqual([
      sha256(screenshot),
    ]);
    expect(JSON.stringify(result.receipt)).not.toContain(encoded);
  });

  it("blocks a forbidden claim found in browser-decoded visible text", async () => {
    const input = assignment("rendered-forbidden-entity");
    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "f".repeat(64),
      contract: input.contract,
      sandbox: new StubRenderedSandbox((paths) =>
        paths.map((path) => ({
          path,
          status: 200,
          // Chromium has already decoded source such as 24&#47;7 here.
          visibleText: "Mission Peak Electric 24/7 emergency service",
          screenshotSha256s: ["4".repeat(64), "5".repeat(64), "6".repeat(64)],
        })),
      ),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("FAIL");
    expect(result.receipt.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ forbiddenClaimIndices: [0] }),
      ]),
    );
  });

  it("blocks a claim decoded only after a fresh-state button interaction", async () => {
    const input = assignment("rendered-click-forbidden");
    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "3".repeat(64),
      contract: input.contract,
      sandbox: new StubRenderedSandbox((paths) =>
        paths.map((path) => ({
          path,
          status: 200,
          // The second state was revealed by a button that decoded atob text.
          visibleText: "Mission Peak Electric Contact 24/7 emergency service",
          screenshotSha256s: ["a".repeat(64), "b".repeat(64)],
        })),
      ),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("FAIL");
    expect(result.receipt.checks[0]?.forbiddenClaimIndices).toEqual([0]);
    expect(result.receipt.checks[0]?.screenshotSha256s).toHaveLength(2);
  });

  it("blocks a claim revealed only by the bounded A-then-B state sequence", async () => {
    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "c".repeat(64),
      contract: assignment("rendered-combined-click-forbidden").contract,
      sandbox: new StubRenderedSandbox((paths) =>
        paths.map((path) => ({
          path,
          status: 200,
          // Baseline and A were safe; the third merged state is A followed by B.
          visibleText:
            "Mission Peak Electric A enabled B enabled 24/7 emergency service",
          screenshotSha256s: ["c".repeat(64), "d".repeat(64), "e".repeat(64)],
        })),
      ),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("FAIL");
    expect(result.receipt.checks[0]?.forbiddenClaimIndices).toEqual([0]);
    expect(result.receipt.checks[0]?.screenshotSha256s).toHaveLength(3);
  });

  it("accepts six full-page tiles across a baseline and three control states", async () => {
    const tileDigests = Array.from({ length: 24 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );
    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "4".repeat(64),
      contract: assignment("rendered-multitile-controls").contract,
      sandbox: new StubRenderedSandbox((paths) =>
        paths.map((path) => ({
          path,
          status: 200,
          visibleText: "Mission Peak Electric",
          screenshotSha256s: tileDigests,
        })),
      ),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("PASS");
    expect(result.receipt.checks[0]?.screenshotSha256s).toHaveLength(24);
  });

  it("fails closed on non-HTML anchors and follows same-origin redirects as pages", async () => {
    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "7".repeat(64),
      contract: assignment("rendered-resource-classification").contract,
      sandbox: new StubRenderedSandbox((paths) => [
        ...paths.map((path) => ({
          path,
          status: 200,
          visibleText: "Mission Peak Electric",
          screenshotSha256s: ["7".repeat(64)],
        })),
        {
          path: "/brochure.pdf",
          discovered: true,
          status: 200,
          nonHtmlMediaType: "application/pdf",
        },
        {
          // The browser followed /legacy to its same-origin final HTML page.
          path: "/legacy",
          discovered: true,
          status: 200,
          visibleText: "Redirect destination",
          screenshotSha256s: ["8".repeat(64)],
        },
      ]),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("ERROR");
    const brochure = result.receipt.checks.find(
      (check) => check.path === "/brochure.pdf",
    );
    expect(brochure).toMatchObject({
      discovered: true,
      nonHtmlMediaType: "application/pdf",
    });
    expect(brochure?.error).toContain("no type-specific");
    expect(result.pages.map((page) => page.path)).toEqual(["/", "/legacy"]);
  });

  it("blocks a browser-decoded forbidden claim on an unlisted reachable route", async () => {
    const input = assignment("rendered-discovered-forbidden");
    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "e".repeat(64),
      contract: input.contract,
      sandbox: new StubRenderedSandbox((paths) => [
        ...paths.map((path) => ({
          path,
          status: 200,
          visibleText: "Mission Peak Electric",
          screenshotSha256s: ["5".repeat(64)],
        })),
        {
          path: "/unlisted-offer",
          discovered: true,
          status: 200,
          // Chromium decoded 24&#47;7 in the reachable route before returning it.
          visibleText: "Call for 24/7 emergency service",
          screenshotSha256s: ["6".repeat(64), "7".repeat(64)],
        },
      ]),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("FAIL");
    expect(result.receipt.checks).toContainEqual(
      expect.objectContaining({
        discovered: true,
        path: "/unlisted-offer",
        forbiddenClaimIndices: [0],
        screenshotSha256s: ["6".repeat(64), "7".repeat(64)],
      }),
    );
    expect(result.pages.map((page) => page.path)).toEqual([
      "/",
      "/unlisted-offer",
    ]);
  });

  it("fails closed when browser discovery exceeds 32 total routes", async () => {
    await expect(
      inspectPreview({
        runId: crypto.randomUUID(),
        revisionHash: "8".repeat(64),
        contract: assignment("rendered-route-limit").contract,
        sandbox: new StubRenderedSandbox((paths) => [
          ...paths.map((path) => ({
            path,
            status: 200,
            visibleText: "Mission Peak Electric",
            screenshotSha256s: ["8".repeat(64)],
          })),
          ...Array.from({ length: 32 }, (_, index) => ({
            path: `/route-${index}`,
            discovered: true as const,
            status: 200,
            visibleText: `Route ${index}`,
            screenshotSha256s: ["9".repeat(64)],
          })),
        ]),
        previewPort: 3_000,
        trace: new TestSpan(),
      }),
    ).rejects.toThrow("at most 32 routes");
  });

  it("records a failed HTTP preference without blocking proof", async () => {
    const input = assignment("rendered-preference");
    const preference = input.contract.requirements.find(
      (requirement) => requirement.priority === "preference",
    );
    if (!preference) {
      throw new Error("Fixture is missing a preference");
    }
    preference.verifiers.push({
      kind: "http",
      path: "/",
      expectedStatus: 200,
      bodyIncludes: ["Optional animated flourish"],
    });

    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "c".repeat(64),
      contract: input.contract,
      sandbox: new StubRenderedSandbox((paths) =>
        paths.map((path) => ({
          path,
          status: 200,
          visibleText: "Mission Peak Electric",
          screenshotSha256s: ["3".repeat(64)],
        })),
      ),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("PASS");
    expect(
      result.receipt.checks.find(
        (check) => check.requirementId === preference.id,
      )?.missingText,
    ).toEqual(["Optional animated flourish"]);
  });

  it("accepts an unambiguous rendered error result and fails closed", async () => {
    const result = await inspectPreview({
      runId: crypto.randomUUID(),
      revisionHash: "c".repeat(64),
      contract: assignment("rendered-error").contract,
      sandbox: new StubRenderedSandbox((paths) =>
        paths.map((path) => ({
          path,
          status: null,
          error: "browser timed out",
        })),
      ),
      previewPort: 3_000,
      trace: new TestSpan(),
    });

    expect(result.receipt.status).toBe("ERROR");
    expect(result.receipt.checks[0]?.error).toContain("browser timed out");
    expect(result.pages).toEqual([]);
  });

  it.each([
    {
      name: "both success and error",
      result: {
        path: "/",
        status: 200,
        visibleText: "Mission Peak Electric",
        error: "ambiguous",
      },
    },
    {
      name: "neither success nor error",
      result: {
        path: "/",
        status: null,
      },
    },
  ])("rejects $name output", async ({ result }) => {
    await expect(
      inspectPreview({
        runId: crypto.randomUUID(),
        revisionHash: "d".repeat(64),
        contract: assignment("rendered-ambiguous").contract,
        sandbox: new StubRenderedSandbox(() => [
          result as RenderedPageInspection,
        ]),
        previewPort: 3_000,
        trace: new TestSpan(),
      }),
    ).rejects.toThrow("ambiguous result");
  });

  it("rejects screenshot bytes that do not match their bound digest", async () => {
    await expect(
      inspectPreview({
        runId: crypto.randomUUID(),
        revisionHash: "9".repeat(64),
        contract: assignment("rendered-screenshot-tamper").contract,
        sandbox: new StubRenderedSandbox(() => [
          {
            path: "/",
            status: 200,
            visibleText: "Mission Peak Electric",
            screenshotSha256s: ["9".repeat(64)],
            screenshotBase64s: [
              Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString(
                "base64",
              ),
            ],
          },
        ]),
        previewPort: 3_000,
        trace: new TestSpan(),
      }),
    ).rejects.toThrow("ambiguous result");
  });
});

class StubRenderedSandbox implements Pick<
  SandboxSession,
  "inspectRenderedPages"
> {
  constructor(
    private readonly inspect: (paths: string[]) => RenderedPageInspection[],
  ) {}

  inspectRenderedPages(paths: string[]): Promise<RenderedPageInspection[]> {
    return Promise.resolve(this.inspect(paths));
  }
}

class TestSpan implements TraceSpan {
  readonly traceId = "trace-preview";

  log(): void {}

  child<T>(
    _name: string,
    _type: "function" | "llm" | "review" | "score" | "task" | "tool",
    _input: unknown,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    return operation(this);
  }
}
