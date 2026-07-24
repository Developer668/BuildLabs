import {
  MAX_RENDERED_ROUTE_COUNT,
  type AcceptanceContract,
} from "../domain/contract.js";
import type { PreviewReceipt } from "../domain/evidence.js";
import { digestJson, sha256 } from "../lib/canonical-json.js";
import { boundText } from "../lib/redaction.js";
import type {
  InspectedPage,
  RenderedPageInspection,
  SandboxSession,
  TraceSpan,
} from "../ports/index.js";
import { createReceiptBase } from "./receipts.js";

interface PreviewCheckTarget {
  requirementId?: string;
  verifierIndex?: number;
  discovered?: true;
  blocking: boolean;
  path: string;
  expectedStatus: number;
  bodyIncludes: string[];
}

export const MAX_RENDERED_ROUTES = MAX_RENDERED_ROUTE_COUNT;
const MAX_PREVIEW_VISIBLE_TEXT_BYTES = 100_000;
const MAX_TOTAL_VISIBLE_TEXT_BYTES = 4 * 1_024 * 1_024;
const RENDERED_PREVIEW_PROTOCOL =
  "daytona-playwright-visible-text-route-crawl-v2";

export interface PreviewInspectionRequest {
  runId: string;
  revisionHash: string;
  contract: AcceptanceContract;
  sandbox: Pick<SandboxSession, "inspectRenderedPages">;
  previewPort: number;
  trace: TraceSpan;
  signal?: AbortSignal | undefined;
  timeoutMilliseconds?: number;
}

export interface PreviewInspectionResult {
  receipt: PreviewReceipt;
  pages: InspectedPage[];
}

export async function inspectPreview(
  request: PreviewInspectionRequest,
): Promise<PreviewInspectionResult> {
  const targets = previewTargets(request.contract);
  const uniquePaths = [...new Set(targets.map((target) => target.path))];
  if (uniquePaths.length > MAX_RENDERED_ROUTES) {
    throw new Error(
      `Preview inspection exceeds the ${MAX_RENDERED_ROUTES}-route limit`,
    );
  }
  const pagesByPath = new Map<
    string,
    | {
        status: number;
        visibleText?: string;
        screenshotSha256s?: string[];
        screenshotBase64s?: string[];
        nonHtmlMediaType?: string;
      }
    | Error
  >();
  const startedAt = new Date().toISOString();
  let inspections: RenderedPageInspection[] = [];

  await request.trace.child(
    "preview.inspect",
    "tool",
    { paths: uniquePaths, renderer: "daytona-playwright" },
    async (span) => {
      inspections = await request.sandbox.inspectRenderedPages(
        uniquePaths,
        request.previewPort,
        request.timeoutMilliseconds ?? 120_000,
        request.signal,
      );
      const inspectedByPath = validateRenderedInspections(
        uniquePaths,
        inspections,
      );
      let totalVisibleTextBytes = 0;
      for (const path of inspectedByPath.keys()) {
        const inspected = inspectedByPath.get(path)!;
        if (inspected.error || inspected.status === null) {
          pagesByPath.set(
            path,
            new Error(inspected.error ?? "Rendered preview returned no status"),
          );
          continue;
        }
        if (inspected.nonHtmlMediaType) {
          pagesByPath.set(path, {
            status: inspected.status,
            nonHtmlMediaType: inspected.nonHtmlMediaType,
          });
          continue;
        }
        const visibleText = requireTextWithinLimit(
          inspected.visibleText!,
          MAX_PREVIEW_VISIBLE_TEXT_BYTES,
        );
        totalVisibleTextBytes += Buffer.byteLength(visibleText, "utf8");
        if (totalVisibleTextBytes > MAX_TOTAL_VISIBLE_TEXT_BYTES) {
          throw new Error(
            `Preview inspection exceeds the ${MAX_TOTAL_VISIBLE_TEXT_BYTES}-byte aggregate visible-text limit`,
          );
        }
        pagesByPath.set(path, {
          status: inspected.status,
          visibleText,
          screenshotSha256s: inspected.screenshotSha256s!,
          ...(inspected.screenshotBase64s
            ? { screenshotBase64s: inspected.screenshotBase64s }
            : {}),
        });
      }
      span.log({
        output: {
          paths: [...pagesByPath].map(([path, result]) => {
            return result instanceof Error
              ? { path, error: result.message }
              : { path, status: result?.status };
          }),
        },
      });
    },
  );

  const discoveredTargets: PreviewCheckTarget[] = inspections.flatMap(
    (inspection) =>
      inspection.discovered
        ? [
            {
              discovered: true as const,
              blocking: true,
              path: inspection.path,
              expectedStatus: 200,
              bodyIncludes: [],
            },
          ]
        : [],
  );
  const allTargets = [...targets, ...discoveredTargets];
  const checks: PreviewReceipt["checks"] = allTargets.map((target) => {
    const result = pagesByPath.get(target.path);
    if (!result || result instanceof Error) {
      return {
        ...(target.discovered ? { discovered: true as const } : {}),
        path: target.path,
        expectedStatus: target.expectedStatus,
        actualStatus: null,
        expectedText: target.bodyIncludes,
        missingText: target.bodyIncludes,
        error: boundText(
          result instanceof Error
            ? result.message
            : "Preview was not inspected",
          4_096,
        ),
        ...(target.requirementId
          ? {
              requirementId: target.requirementId,
              verifierIndex: target.verifierIndex,
            }
          : {}),
      };
    }
    if (result.nonHtmlMediaType) {
      return {
        ...(target.discovered ? { discovered: true as const } : {}),
        path: target.path,
        expectedStatus: target.expectedStatus,
        actualStatus: result.status,
        expectedText: target.bodyIncludes,
        missingText: target.bodyIncludes,
        nonHtmlMediaType: result.nonHtmlMediaType,
        error: `Reachable non-HTML content (${result.nonHtmlMediaType}) has no type-specific rendered-claim evidence`,
        ...(target.requirementId
          ? {
              requirementId: target.requirementId,
              verifierIndex: target.verifierIndex,
            }
          : {}),
      };
    }

    const missingText = target.bodyIncludes.filter(
      (expected) => !result.visibleText!.includes(expected),
    );
    const forbiddenClaimIndices = matchingForbiddenClaimIndices(
      result.visibleText!,
      request.contract.forbiddenClaims,
    );
    return {
      ...(target.discovered ? { discovered: true as const } : {}),
      path: target.path,
      expectedStatus: target.expectedStatus,
      actualStatus: result.status,
      expectedText: target.bodyIncludes,
      missingText,
      forbiddenClaimIndices,
      visibleTextDigest: sha256(result.visibleText!),
      screenshotSha256s: result.screenshotSha256s!,
      ...(target.requirementId
        ? {
            requirementId: target.requirementId,
            verifierIndex: target.verifierIndex,
          }
        : {}),
    };
  });

  const hasError = checks.some(
    (check, index) => allTargets[index]?.blocking && Boolean(check.error),
  );
  const hasFailure = checks.some(
    (check, index) =>
      (allTargets[index]?.blocking &&
        (check.actualStatus !== check.expectedStatus ||
          check.missingText.length > 0)) ||
      (check.forbiddenClaimIndices?.length ?? 0) > 0,
  );
  const status = hasError ? "ERROR" : hasFailure ? "FAIL" : "PASS";
  const completedAt = new Date().toISOString();
  const receipt: PreviewReceipt = {
    ...createReceiptBase({
      runId: request.runId,
      revisionHash: request.revisionHash,
      status,
      startedAt,
      completedAt,
      input: renderedPreviewInput(request.contract),
      output: checks,
    }),
    kind: "preview",
    provider: "daytona",
    checks,
  };

  const pages: InspectedPage[] = [];
  for (const [path, result] of pagesByPath) {
    if (!(result instanceof Error) && result.visibleText !== undefined) {
      pages.push({
        path,
        status: result.status,
        visibleText: result.visibleText,
        ...(result.screenshotBase64s
          ? { screenshotBase64s: result.screenshotBase64s }
          : {}),
      });
    }
  }

  return { receipt, pages };
}

function previewTargets(contract: AcceptanceContract): PreviewCheckTarget[] {
  const targets: PreviewCheckTarget[] = [
    {
      blocking: true,
      path: "/",
      expectedStatus: 200,
      bodyIncludes: [],
    },
  ];

  for (const requirement of contract.requirements) {
    for (const [verifierIndex, verifier] of requirement.verifiers.entries()) {
      if (verifier.kind !== "http") {
        continue;
      }
      targets.push({
        requirementId: requirement.id,
        verifierIndex,
        blocking: requirement.priority === "hard",
        path: verifier.path,
        expectedStatus: verifier.expectedStatus,
        bodyIncludes: verifier.bodyIncludes,
      });
    }
  }

  return targets;
}

export function previewInputDigest(contract: AcceptanceContract): string {
  return digestJson(renderedPreviewInput(contract));
}

function renderedPreviewInput(contract: AcceptanceContract): {
  renderer: string;
  crawl: {
    strategy: "frozen-dom-same-origin-bfs";
    maxRoutes: number;
    discoveredExpectedStatus: 200;
  };
  renderedSurface: {
    viewport: "1440x900";
    maxVerticalTiles: 16;
    maxScreenshotTilesPerRoute: 256;
    maxTotalScreenshotTiles: 512;
    maxDocumentHeight: 14_400;
    screenshotDigest: "sha256-per-tile";
    maxControllerScreenshotBytes: 6_291_456;
    screenshotBytes: "controller-only-canonical-base64";
    unchangedTilePolicy: "parent-byte-exact-proof-reuse";
    evidenceDeduplication: "sha256-tile-and-visible-text-state";
    reject: [
      "canvas",
      "video",
      "iframe",
      "embed",
      "object",
      "data-blob-images",
      "generated-pseudo-content",
      "javascript-anchors",
      "unsupported-form-controls",
      "initial-websockets",
      "post-load-network",
    ];
  };
  interactions: {
    strategy: "fresh-state-network-blocked-bfs";
    maxVisibleControls: 15;
    maxActionsPerState: 45;
    maxUniqueStates: 15;
    maxTerminalProbeStates: 30;
    maxTransitions: 64;
    stabilizationMilliseconds: 250;
    controlPolicy: "controller-bounded-form-anchor-control-actions";
    formWorkflow: "canonical-visible-fields-then-prevented-submit";
    finiteChoicePolicy: "all-bounded-options";
    hoverFocusPolicy: "authored-terminal-handler-stateful";
    repeatedActionPolicy: "once-per-sequence";
    unobservableTransition: "fail-closed";
  };
  targets: PreviewCheckTarget[];
  forbiddenClaims: string[];
} {
  return {
    renderer: RENDERED_PREVIEW_PROTOCOL,
    crawl: {
      strategy: "frozen-dom-same-origin-bfs",
      maxRoutes: MAX_RENDERED_ROUTES,
      discoveredExpectedStatus: 200,
    },
    renderedSurface: {
      viewport: "1440x900",
      maxVerticalTiles: 16,
      maxScreenshotTilesPerRoute: 256,
      maxTotalScreenshotTiles: 512,
      maxDocumentHeight: 14_400,
      screenshotDigest: "sha256-per-tile",
      maxControllerScreenshotBytes: 6_291_456,
      screenshotBytes: "controller-only-canonical-base64",
      unchangedTilePolicy: "parent-byte-exact-proof-reuse",
      evidenceDeduplication: "sha256-tile-and-visible-text-state",
      reject: [
        "canvas",
        "video",
        "iframe",
        "embed",
        "object",
        "data-blob-images",
        "generated-pseudo-content",
        "javascript-anchors",
        "unsupported-form-controls",
        "initial-websockets",
        "post-load-network",
      ],
    },
    interactions: {
      strategy: "fresh-state-network-blocked-bfs",
      maxVisibleControls: 15,
      maxActionsPerState: 45,
      maxUniqueStates: 15,
      maxTerminalProbeStates: 30,
      maxTransitions: 64,
      stabilizationMilliseconds: 250,
      controlPolicy: "controller-bounded-form-anchor-control-actions",
      formWorkflow: "canonical-visible-fields-then-prevented-submit",
      finiteChoicePolicy: "all-bounded-options",
      hoverFocusPolicy: "authored-terminal-handler-stateful",
      repeatedActionPolicy: "once-per-sequence",
      unobservableTransition: "fail-closed",
    },
    targets: previewTargets(contract),
    forbiddenClaims: contract.forbiddenClaims,
  };
}

function validateRenderedInspections(
  expectedPaths: string[],
  inspections: RenderedPageInspection[],
): Map<string, RenderedPageInspection> {
  if (
    inspections.length < expectedPaths.length ||
    inspections.length > MAX_RENDERED_ROUTES
  ) {
    throw new Error(
      `Rendered preview inspector returned an invalid result count; at most ${MAX_RENDERED_ROUTES} routes are allowed`,
    );
  }
  const expected = new Set(expectedPaths);
  const byPath = new Map<string, RenderedPageInspection>();
  let totalScreenshotBytes = 0;
  let totalScreenshotTiles = 0;
  for (const [index, inspection] of inspections.entries()) {
    const requestedPath = expectedPaths[index];
    const isRequested = requestedPath !== undefined;
    if (
      (isRequested &&
        (inspection.path !== requestedPath || inspection.discovered)) ||
      (!isRequested &&
        (!inspection.discovered ||
          expected.has(inspection.path) ||
          !isCanonicalRenderedRoutePath(inspection.path))) ||
      byPath.has(inspection.path)
    ) {
      throw new Error(
        "Rendered preview inspector returned an unexpected or duplicate path",
      );
    }
    if (
      inspection.status !== null &&
      (!Number.isInteger(inspection.status) ||
        inspection.status < 100 ||
        inspection.status > 599)
    ) {
      throw new Error("Rendered preview inspector returned an invalid status");
    }
    const hasStatus = inspection.status !== null;
    const hasError = typeof inspection.error === "string";
    const hasText = typeof inspection.visibleText === "string";
    const hasNonHtmlMediaType =
      typeof inspection.nonHtmlMediaType === "string" &&
      inspection.nonHtmlMediaType.length >= 1 &&
      inspection.nonHtmlMediaType.length <= 200;
    const hasScreenshots =
      Array.isArray(inspection.screenshotSha256s) &&
      inspection.screenshotSha256s.length >= 1 &&
      inspection.screenshotSha256s.length <= 256 &&
      inspection.screenshotSha256s.every((digest) =>
        /^[a-f0-9]{64}$/.test(digest),
      );
    const hasValidOptionalScreenshotBytes =
      inspection.screenshotBase64s === undefined ||
      (hasScreenshots &&
        inspection.screenshotBase64s.length ===
          inspection.screenshotSha256s!.length &&
        inspection.screenshotBase64s.every((encoded, screenshotIndex) => {
          const bytes = decodeCanonicalBase64(encoded);
          if (
            !bytes ||
            bytes.length < 8 ||
            !bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            sha256(bytes) !== inspection.screenshotSha256s![screenshotIndex]
          ) {
            return false;
          }
          totalScreenshotBytes += bytes.length;
          return totalScreenshotBytes <= 6 * 1_024 * 1_024;
        }));
    if (hasScreenshots) {
      totalScreenshotTiles += inspection.screenshotSha256s!.length;
      if (totalScreenshotTiles > 512) {
        throw new Error(
          "Rendered preview inspector returned more than 512 screenshot tiles",
        );
      }
    }
    if (
      hasStatus
        ? hasError ||
          (hasNonHtmlMediaType
            ? hasText ||
              inspection.screenshotSha256s !== undefined ||
              inspection.screenshotBase64s !== undefined
            : !hasText || !hasScreenshots || !hasValidOptionalScreenshotBytes)
        : !hasError ||
          inspection.visibleText !== undefined ||
          inspection.screenshotSha256s !== undefined ||
          inspection.screenshotBase64s !== undefined ||
          inspection.nonHtmlMediaType !== undefined
    ) {
      throw new Error(
        "Rendered preview inspector returned an ambiguous result",
      );
    }
    byPath.set(inspection.path, inspection);
  }
  return byPath;
}

function decodeCanonicalBase64(input: string): Buffer | undefined {
  if (
    input.length === 0 ||
    input.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      input,
    )
  ) {
    return undefined;
  }
  const decoded = Buffer.from(input, "base64");
  return decoded.toString("base64") === input ? decoded : undefined;
}

function isCanonicalRenderedRoutePath(path: string): boolean {
  if (
    path.length < 1 ||
    path.length > 2_000 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("#")
  ) {
    return false;
  }
  try {
    const url = new URL(path, "http://127.0.0.1");
    return (
      url.origin === "http://127.0.0.1" &&
      `${url.pathname}${url.search}` === path
    );
  } catch {
    return false;
  }
}

function requireTextWithinLimit(input: string, maxBytes: number): string {
  const bytes = Buffer.from(input, "utf8");
  if (bytes.length > maxBytes) {
    throw new Error(
      `Preview response exceeds the ${maxBytes}-byte inspection limit`,
    );
  }
  return input;
}

function matchingForbiddenClaimIndices(
  visibleText: string,
  forbiddenClaims: readonly string[],
): number[] {
  const haystack = normalizeVisibleText(visibleText);
  return forbiddenClaims.flatMap((claim, index) =>
    haystack.includes(normalizeVisibleText(claim)) ? [index] : [],
  );
}

function normalizeVisibleText(input: string): string {
  return input
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}
