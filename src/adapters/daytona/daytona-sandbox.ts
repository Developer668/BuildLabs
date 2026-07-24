import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix, relative, resolve, sep } from "node:path";

import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import * as tar from "tar";

import type { AppConfig } from "../../config.js";
import {
  MAX_RENDERED_ROUTE_COUNT,
  type BuildAssignment,
} from "../../domain/contract.js";
import type { FrozenRevision } from "../../domain/run.js";
import { sha256 } from "../../lib/canonical-json.js";
import { boundText } from "../../lib/redaction.js";
import type {
  CommandResult,
  ExportedWorkspace,
  FrozenPreviewMaterializationRequest,
  PreviewTarget,
  RenderedPageInspection,
  SandboxFile,
  SandboxProvider,
  SandboxSession,
  VerificationSandboxPurpose,
} from "../../ports/index.js";

const GIT_EXCLUDES = [
  ".buildlabs/",
  ".next/",
  ".nuxt/",
  ".output/",
  "coverage/",
  "dist/",
  "node_modules/",
  "target/",
];
const MAX_ARCHIVE_BYTES = 500 * 1_024 * 1_024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_FILE_BYTES = 50 * 1_024 * 1_024;
const MAX_COMMAND_ENVELOPE_BYTES = 1_048_576;
const COMMAND_ENVELOPE_OVERHEAD_BYTES = 512;
const COMMAND_ENVELOPE_MAGIC = "BUILDLABS_COMMAND_RESULT_V1";
const RENDER_INSPECTOR_PATH =
  "/tmp/buildlabs-controller-render-inspector-v2.cjs";
const PLAYWRIGHT_NODE_PATH = "/opt/buildlabs-render-inspector/node_modules";
const MAX_RENDER_PATHS = MAX_RENDERED_ROUTE_COUNT;
const MAX_RENDER_TOTAL_TIMEOUT_MILLISECONDS = 120_000;
const RENDER_COMMAND_ENVELOPE_BYTES = 12 * 1_024 * 1_024;
const MAX_RENDERED_TEXT_BYTES = 100_000;
const MAX_RENDER_SCREENSHOT_TILES = 256;
const MAX_RENDER_TOTAL_SCREENSHOT_TILES = 512;
const MAX_RENDER_SCREENSHOT_BYTES = 6 * 1_024 * 1_024;
const MAX_PIXEL_BASELINE_RESTORE_CAPTURES = 5;
const PIXEL_BASELINE_RESTORE_PAINT_DELAY_MILLISECONDS = 32;
const MAX_DOCKER_SANDBOX_INITIALIZATION_ATTEMPTS = 2;

export class DaytonaDockerRuntimeError extends Error {
  override readonly name = "DaytonaDockerRuntimeError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

interface ReadableGraphemeSegment {
  text: string;
  readable: boolean;
  whitespace: boolean;
}

export function assembleReadableGraphemeText(
  segments: readonly ReadableGraphemeSegment[],
): string {
  const firstReadable = segments.findIndex((segment) => segment.readable);
  if (firstReadable < 0) {
    return "";
  }
  let lastReadable = segments.length - 1;
  while (!segments[lastReadable]?.readable) {
    lastReadable -= 1;
  }
  let output = "";
  let omittedText = false;
  for (let index = firstReadable; index <= lastReadable; index += 1) {
    const segment = segments[index]!;
    if (segment.readable) {
      if (omittedText && output && !/\s$/u.test(output)) {
        output += " ";
      }
      output += segment.text;
      omittedText = false;
    } else if (segment.whitespace) {
      output += segment.text;
      omittedText = false;
    } else {
      omittedText = true;
    }
  }
  return output;
}

interface ReadablePixelEvidence {
  visibleAreaRatio: number;
  inspectedPixels: number;
  readablePixels: number;
}

export function hasSufficientReadablePixelEvidence(
  evidence: ReadablePixelEvidence,
): boolean {
  return (
    evidence.visibleAreaRatio >= 0.5 &&
    evidence.inspectedPixels > 0 &&
    evidence.readablePixels >=
      Math.max(3, Math.ceil(evidence.inspectedPixels * 0.005))
  );
}

export function planScrollTileOffsets(
  documentHeight: number,
  viewportHeight: number,
  maxTiles: number,
): number[] {
  if (
    !Number.isSafeInteger(documentHeight) ||
    !Number.isSafeInteger(viewportHeight) ||
    !Number.isSafeInteger(maxTiles) ||
    documentHeight < 1 ||
    viewportHeight < 1 ||
    maxTiles < 1
  ) {
    throw new Error("Rendered-page dimensions are invalid");
  }
  const maximumScroll = Math.max(0, documentHeight - viewportHeight);
  const offsets = [0];
  for (
    let offset = viewportHeight;
    offset < maximumScroll;
    offset += viewportHeight
  ) {
    offsets.push(offset);
  }
  if (maximumScroll > 0 && offsets.at(-1) !== maximumScroll) {
    offsets.push(maximumScroll);
  }
  if (offsets.length > maxTiles) {
    throw new Error(
      `Rendered page exceeds the ${maxTiles}-tile inspection limit`,
    );
  }
  return offsets;
}

export function normalizeSameOriginRoutePaths(
  hrefs: readonly string[],
  origin: string,
): string[] {
  const routes = new Set<string>();
  for (const href of hrefs) {
    try {
      const url = new URL(href);
      if (
        url.origin !== origin ||
        (url.protocol !== "http:" && url.protocol !== "https:")
      ) {
        continue;
      }
      const route = `${url.pathname}${url.search}`;
      if (
        route.length >= 1 &&
        route.length <= 2_000 &&
        route.startsWith("/") &&
        !route.startsWith("//") &&
        !route.includes("\\")
      ) {
        routes.add(route);
      }
    } catch {
      // Non-HTTP and malformed hrefs are not crawlable routes.
    }
  }
  return [...routes].sort();
}

export function assertObservableInteractionTransition(
  currentStateDigest: string,
  nextStateDigest: string,
): void {
  if (currentStateDigest === nextStateDigest) {
    throw new Error(
      "Rendered-page interaction changed no controller-observable state",
    );
  }
}

export type ProofNetworkRequestDecision =
  "allow" | "block-disallowed" | "block-initial-websocket" | "block-post-load";

export function decideProofNetworkRequest(input: {
  kind: "http" | "websocket";
  blockedAfterLoad: boolean;
  allowedUrl: boolean;
  allowInitialWebSockets: boolean;
}): ProofNetworkRequestDecision {
  if (input.blockedAfterLoad) {
    return "block-post-load";
  }
  if (!input.allowedUrl) {
    return "block-disallowed";
  }
  if (input.kind === "websocket" && !input.allowInitialWebSockets) {
    return "block-initial-websocket";
  }
  return "allow";
}

interface RenderedTileReuseMetadata {
  offset: number;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
}

export function canReuseRenderedTileProof(
  current: RenderedTileReuseMetadata,
  parent: RenderedTileReuseMetadata,
  screenshotBytesEqual: boolean,
  candidateStateEqual: boolean,
): boolean {
  return (
    screenshotBytesEqual &&
    candidateStateEqual &&
    current.offset === parent.offset &&
    current.viewportWidth === parent.viewportWidth &&
    current.viewportHeight === parent.viewportHeight &&
    current.documentWidth === parent.documentWidth &&
    current.documentHeight === parent.documentHeight
  );
}

interface PixelBaselineCapturePage {
  waitForTimeout(milliseconds: number): Promise<unknown>;
  screenshot(options: {
    animations: "disabled";
    caret: "hide";
    scale: "css";
    type: "png";
  }): Promise<Buffer>;
}

interface PixelDifferenceSummary {
  differingBytes: number;
  differingPixels: number;
  maxChannelDelta: number;
}

export async function recaptureExactPixelBaseline(
  page: PixelBaselineCapturePage,
  baselineBuffer: Buffer,
  deadline: number,
  summarizeDifference: (
    expectedBuffer: Buffer,
    actualBuffer: Buffer,
  ) => PixelDifferenceSummary,
): Promise<Buffer> {
  const captures: Buffer[] = [];
  let baselineMatches = 0;
  let consecutiveBaselineMatches = 0;
  let maxConsecutiveBaselineMatches = 0;
  for (
    let attempt = 0;
    attempt < MAX_PIXEL_BASELINE_RESTORE_CAPTURES;
    attempt += 1
  ) {
    if (attempt > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= PIXEL_BASELINE_RESTORE_PAINT_DELAY_MILLISECONDS) {
        break;
      }
      await page.waitForTimeout(
        PIXEL_BASELINE_RESTORE_PAINT_DELAY_MILLISECONDS,
      );
    }
    if (Date.now() >= deadline) {
      break;
    }
    const capture = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png",
    });
    captures.push(capture);
    if (capture.equals(baselineBuffer)) {
      baselineMatches += 1;
      consecutiveBaselineMatches += 1;
      maxConsecutiveBaselineMatches = Math.max(
        maxConsecutiveBaselineMatches,
        consecutiveBaselineMatches,
      );
      if (attempt === 0 || consecutiveBaselineMatches >= 2) {
        return capture;
      }
    } else {
      consecutiveBaselineMatches = 0;
    }
  }
  const lastCapture = captures.at(-1);
  const difference = lastCapture
    ? summarizeDifference(baselineBuffer, lastCapture)
    : { differingBytes: 0, differingPixels: 0, maxChannelDelta: 0 };
  const distinctCaptureCount = new Set(
    captures.map((capture) =>
      createHash("sha256").update(capture).digest("hex"),
    ),
  ).size;
  throw new Error(
    "Rendered-page probe did not restore the exact pixel baseline " +
      "(captures=" +
      String(captures.length) +
      ",baselineMatches=" +
      String(baselineMatches) +
      ",maxConsecutiveBaselineMatches=" +
      String(maxConsecutiveBaselineMatches) +
      ",distinctCaptures=" +
      String(distinctCaptureCount) +
      ",differingBytes=" +
      String(difference.differingBytes) +
      ",differingPixels=" +
      String(difference.differingPixels) +
      ",maxChannelDelta=" +
      String(difference.maxChannelDelta) +
      ")",
  );
}

export const RENDERED_PAGE_INSPECTOR_SOURCE = String.raw`
"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { inflateSync } = require("node:zlib");
const { chromium } = require("playwright-core");

const MAX_PATHS = 32;
const MAX_TEXT_BYTES = 100000;
const MAX_TOTAL_TEXT_BYTES = 300000;
const MAX_SERIALIZED_OUTPUT_BYTES = 9 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024;
const MAX_SCROLL_TILES = 16;
const MAX_SCREENSHOT_TILES_PER_ROUTE = 256;
const MAX_TOTAL_SCREENSHOT_TILES = 512;
const MAX_DOCUMENT_HEIGHT = 14400;
const MAX_ANCHORS = 1024;
const MAX_ANCHOR_HREF_BYTES = 100000;
const MAX_INTERACTIONS = 15;
const MAX_INTERACTION_ACTIONS = 45;
const MAX_INTERACTION_STATES = 15;
const MAX_TERMINAL_INTERACTION_STATES = 30;
const MAX_INTERACTION_TRANSITIONS = 64;
const MAX_PIXEL_BASELINE_RESTORE_CAPTURES = ${MAX_PIXEL_BASELINE_RESTORE_CAPTURES};
const PIXEL_BASELINE_RESTORE_PAINT_DELAY_MILLISECONDS = ${PIXEL_BASELINE_RESTORE_PAINT_DELAY_MILLISECONDS};
const INTERACTION_SELECTOR = "*";
const assembleReadableGraphemeText = ${assembleReadableGraphemeText.toString()};
const hasSufficientReadablePixelEvidence = ${hasSufficientReadablePixelEvidence.toString()};
const planScrollTileOffsets = ${planScrollTileOffsets.toString()};
const normalizeSameOriginRoutePaths = ${normalizeSameOriginRoutePaths.toString()};
const assertObservableInteractionTransition = ${assertObservableInteractionTransition.toString()};
const decideProofNetworkRequest = ${decideProofNetworkRequest.toString()};
const canReuseRenderedTileProof = ${canReuseRenderedTileProof.toString()};
const recaptureExactPixelBaseline = ${recaptureExactPixelBaseline.toString()};

function fail(message) {
  throw new Error(message);
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : "Unknown browser inspection failure";
  return message.slice(0, 4096);
}

function parseInput(encoded) {
  let input;
  try {
    input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    fail("Rendered-page inspector input is invalid");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("Rendered-page inspector input is invalid");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    fail("Rendered-page inspector port is invalid");
  }
  if (
    !Number.isInteger(input.timeoutMilliseconds) ||
    input.timeoutMilliseconds < 1000 ||
    input.timeoutMilliseconds > 120000
  ) {
    fail("Rendered-page inspector timeout is invalid");
  }
  if (
    !Array.isArray(input.paths) ||
    input.paths.length < 1 ||
    input.paths.length > MAX_PATHS ||
    input.paths.some(
      (path) =>
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("\\") ||
        path.includes("#") ||
        (() => {
          try {
            const url = new URL(path, "http://127.0.0.1:" + input.port);
            return url.pathname + url.search !== path;
          } catch {
            return true;
          }
        })()
    ) ||
    new Set(input.paths).size !== input.paths.length
  ) {
    fail("Rendered-page inspector paths are invalid");
  }
  return input;
}

function isAllowedHttpUrl(rawUrl, origin) {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
  } catch {
    return false;
  }
}

function isAllowedWebSocketUrl(rawUrl, port) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "ws:" &&
      url.hostname === "127.0.0.1" &&
      url.port === String(port)
    );
  } catch {
    return false;
  }
}

function collectCandidateStateInIsolatedWorld() {
    if (!document.body || !document.documentElement) {
      throw new Error("Rendered page has no document body");
    }
    const MAX_ANCHORS = 1024;
    const MAX_ANCHOR_HREF_BYTES = 100000;
    const MAX_INTERACTIONS = 15;
    const MAX_INTERACTION_ACTIONS = 45;
    const INTERACTION_SELECTOR = "*";
    const MAX_DOM_TEXT_NODES = 10000;
    const MAX_DOM_TEXT_CODE_UNITS = 200000;
    const MAX_RANGED_TEXT_NODES = 2000;
    const MAX_RANGED_TEXT_CODE_UNITS = 20000;
    const MAX_RANGED_RECTS = 40000;
    const MAX_OUTER_HTML_BYTES = 1000000;
    const createRange = Document.prototype.createRange;
    const createTreeWalker = Document.prototype.createTreeWalker;
    const checkVisibility = Element.prototype.checkVisibility;
    const closest = Element.prototype.closest;
    const getBoundingClientRect = Element.prototype.getBoundingClientRect;
    const getClientRects = Range.prototype.getClientRects;
    const getComputedStylePristine = globalThis.getComputedStyle;
    const querySelectorAll = Document.prototype.querySelectorAll;
    const querySelectorAllInElement = Element.prototype.querySelectorAll;
    const getAttribute = Element.prototype.getAttribute;
    const matches = Element.prototype.matches;
    const inputValueGetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    ).get;
    const inputCheckedGetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "checked"
    ).get;
    const textareaValueGetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    ).get;
    const selectValueGetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value"
    ).get;
    const imageCurrentSrcGetter = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "currentSrc"
    ).get;
    const allElements = Array.from(querySelectorAll.call(document, "*"));
    if (allElements.length > 10000) {
      throw new Error("Rendered page exceeds the bounded element limit");
    }
    for (const element of allElements) {
      const bounds = getBoundingClientRect.call(element);
      const rendered =
        bounds.width > 0 &&
        bounds.height > 0 &&
        checkVisibility.call(element, {
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true
        });
      if (!rendered) {
        continue;
      }
      const tagName = element.tagName.toLowerCase();
      if (
        tagName === "canvas" ||
        tagName === "video" ||
        tagName === "iframe" ||
        tagName === "embed" ||
        tagName === "object"
      ) {
        throw new Error(
          "Rendered page contains an unsupported visible raster or embedded surface"
        );
      }
      if (tagName === "img") {
        const imageSources = [
          getAttribute.call(element, "src") ?? "",
          getAttribute.call(element, "srcset") ?? "",
          imageCurrentSrcGetter.call(element) ?? ""
        ];
        if (
          imageSources.some((source) =>
            /(^|[\s,])(data|blob):/iu.test(source.trim())
          )
        ) {
          throw new Error(
            "Rendered page contains a visible data or blob image source"
          );
        }
      }
      const style = getComputedStylePristine(element);
      if (/(?:url|image-set)\([^)]*(?:data|blob):/iu.test(style.backgroundImage)) {
        throw new Error(
          "Rendered page contains a visible data or blob background image"
        );
      }
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStylePristine(element, pseudo).content;
        if (
          content &&
          content !== "none" &&
          content !== "normal" &&
          content !== '""' &&
          content !== "''"
        ) {
          throw new Error(
            "Rendered page contains unsupported generated pseudo-element content"
          );
        }
      }
    }
    const clippedRect = (inputRect, element) => {
      let left = Math.max(0, inputRect.left);
      let top = Math.max(0, inputRect.top);
      let right = Math.min(window.innerWidth, inputRect.right);
      let bottom = Math.min(window.innerHeight, inputRect.bottom);
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== document.documentElement) {
        const style = getComputedStylePristine(ancestor);
        const clipsX = style.overflowX !== "visible";
        const clipsY = style.overflowY !== "visible";
        if (clipsX || clipsY) {
          const bounds = getBoundingClientRect.call(ancestor);
          if (clipsX) {
            left = Math.max(left, bounds.left);
            right = Math.min(right, bounds.right);
          }
          if (clipsY) {
            top = Math.max(top, bounds.top);
            bottom = Math.min(bottom, bounds.bottom);
          }
        }
        ancestor = ancestor.parentElement;
      }
      return left < right && top < bottom
        ? { left, top, right, bottom }
        : null;
    };
    const walker = createTreeWalker.call(
      document,
      document.body,
      NodeFilter.SHOW_TEXT
    );
    const eligibleNodes = [];
    let domTextNodes = 0;
    let domTextCodeUnits = 0;
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (
        parent &&
        !closest.call(
          parent,
          "script,style,noscript,template,[hidden],[aria-hidden='true']"
        )
      ) {
        const rawText = node.textContent ?? "";
        domTextNodes += 1;
        domTextCodeUnits += rawText.length;
        if (
          domTextNodes > MAX_DOM_TEXT_NODES ||
          domTextCodeUnits > MAX_DOM_TEXT_CODE_UNITS
        ) {
          throw new Error("Rendered page exceeds the bounded DOM text limit");
        }
        if (
          rawText.trim() &&
          checkVisibility.call(parent, {
            opacityProperty: true,
            visibilityProperty: true,
            contentVisibilityAuto: true
          })
        ) {
          eligibleNodes.push({ node, parent, rawText });
        }
      }
      node = walker.nextNode();
    }

    const rangedNodes = [];
    let rangedTextCodeUnits = 0;
    for (const candidate of eligibleNodes) {
      const coarseRange = createRange.call(document);
      coarseRange.selectNodeContents(candidate.node);
      const hasVisibleRect = Array.from(getClientRects.call(coarseRange)).some(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          clippedRect(rect, candidate.parent) !== null
      );
      coarseRange.detach();
      if (!hasVisibleRect) {
        continue;
      }
      rangedTextCodeUnits += candidate.rawText.length;
      if (
        rangedNodes.length + 1 > MAX_RANGED_TEXT_NODES ||
        rangedTextCodeUnits > MAX_RANGED_TEXT_CODE_UNITS
      ) {
        throw new Error(
          "Rendered page exceeds the bounded grapheme-range text limit"
        );
      }
      rangedNodes.push(candidate);
    }

    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme"
    });
    const candidates = [];
    let rangedRects = 0;
    for (const { node, parent, rawText } of rangedNodes) {
      const segments = [];
      for (const grapheme of segmenter.segment(rawText)) {
        const range = createRange.call(document);
        range.setStart(node, grapheme.index);
        range.setEnd(node, grapheme.index + grapheme.segment.length);
        const rects = [];
        let totalArea = 0;
        let visibleArea = 0;
        for (const rect of getClientRects.call(range)) {
          if (rect.width <= 0 || rect.height <= 0) {
            continue;
          }
          totalArea += rect.width * rect.height;
          const visibleRect = clippedRect(rect, parent);
          if (visibleRect) {
            rangedRects += 1;
            if (rangedRects > MAX_RANGED_RECTS) {
              throw new Error(
                "Rendered page exceeds the bounded grapheme rectangle limit"
              );
            }
            rects.push(visibleRect);
            visibleArea +=
              (visibleRect.right - visibleRect.left) *
              (visibleRect.bottom - visibleRect.top);
          }
        }
        range.detach();
        if (rects.length > 0 && totalArea > 0) {
          segments.push({
            text: grapheme.segment,
            whitespace: /^\s+$/u.test(grapheme.segment),
            visibleAreaRatio: visibleArea / totalArea,
            rects
          });
        }
      }
      if (segments.length > 0) {
        candidates.push({ segments });
      }
    }
    const outerHTML = document.documentElement.outerHTML;
    if (
      new TextEncoder().encode(outerHTML).byteLength >
      MAX_OUTER_HTML_BYTES
    ) {
      throw new Error("Rendered page exceeds the bounded DOM snapshot limit");
    }
    const anchors = Array.from(
      querySelectorAll.call(document, "a[href]")
    );
    if (anchors.length > MAX_ANCHORS) {
      throw new Error("Rendered page exceeds the bounded anchor limit");
    }
    const anchorHrefs = [];
    let anchorHrefBytes = 0;
    for (const anchor of anchors) {
      const rawHref = getAttribute.call(anchor, "href");
      if (!rawHref) {
        continue;
      }
      if (/^\s*javascript:/iu.test(rawHref)) {
        throw new Error(
          "Rendered page contains an unsupported javascript anchor"
        );
      }
      let resolvedHref;
      try {
        resolvedHref = new URL(rawHref, document.baseURI).href;
      } catch {
        continue;
      }
      anchorHrefBytes += new TextEncoder().encode(resolvedHref).byteLength;
      if (anchorHrefBytes > MAX_ANCHOR_HREF_BYTES) {
        throw new Error("Rendered page exceeds the bounded anchor href limit");
      }
      anchorHrefs.push(resolvedHref);
    }
    const pseudoTriggerSelectors = {
      hover: [],
      focus: [],
      focusWithin: []
    };
    let authoredRuleCount = 0;
    let authoredSelectorBytes = 0;
    const recordPseudoSelectors = (selectorText) => {
      authoredSelectorBytes += selectorText.length;
      if (authoredSelectorBytes > 100000) {
        throw new Error(
          "Rendered page exceeds the bounded authored-selector limit"
        );
      }
      const pattern = /:(hover|focus-within|focus-visible|focus)\b/gu;
      for (const match of selectorText.matchAll(pattern)) {
        const matchIndex = match.index;
        let depth = 0;
        let selectorStart = 0;
        for (let index = 0; index < matchIndex; index += 1) {
          const character = selectorText[index];
          if (character === "(" || character === "[") {
            depth += 1;
          } else if (character === ")" || character === "]") {
            depth = Math.max(0, depth - 1);
          } else if (character === "," && depth === 0) {
            selectorStart = index + 1;
          }
        }
        const triggerSelector = selectorText
          .slice(selectorStart, matchIndex)
          .trim();
        if (!triggerSelector) {
          throw new Error(
            "Rendered page contains an unsupported authored pseudo-state selector"
          );
        }
        try {
          querySelectorAll.call(document, triggerSelector);
        } catch {
          throw new Error(
            "Rendered page contains an unsupported authored pseudo-state selector"
          );
        }
        const pseudo = match[1];
        const bucket =
          pseudo === "hover"
            ? pseudoTriggerSelectors.hover
            : pseudo === "focus-within"
              ? pseudoTriggerSelectors.focusWithin
              : pseudoTriggerSelectors.focus;
        if (!bucket.includes(triggerSelector)) {
          bucket.push(triggerSelector);
        }
      }
    };
    const visitRules = (rules) => {
      for (const rule of Array.from(rules)) {
        authoredRuleCount += 1;
        if (authoredRuleCount > 2000) {
          throw new Error(
            "Rendered page exceeds the bounded authored-style rule limit"
          );
        }
        if (typeof rule.selectorText === "string") {
          recordPseudoSelectors(rule.selectorText);
        }
        if (rule.cssRules) {
          visitRules(rule.cssRules);
        }
      }
    };
    for (const styleSheet of Array.from(document.styleSheets)) {
      try {
        visitRules(styleSheet.cssRules);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Rendered page")
        ) {
          throw error;
        }
        throw new Error(
          "Rendered page contains an unreadable authored stylesheet"
        );
      }
    }
    const interactionElements = allElements;
    const interactionIndex = new Map(
      interactionElements.map((element, index) => [element, index])
    );
    const interactions = [];
    const interactiveControlIndices = new Set();
    const formOwnedControls = new Set();
    const visible = (element) => {
      const bounds = getBoundingClientRect.call(element);
      return (
        !matches.call(element, ":disabled") &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        checkVisibility.call(element, {
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true
        })
      );
    };
    const addInteraction = (element, interaction) => {
      const domIndex = interactionIndex.get(element);
      if (!Number.isSafeInteger(domIndex)) {
        throw new Error("Rendered-page interaction index is invalid");
      }
      interactiveControlIndices.add(domIndex);
      if (interactiveControlIndices.size > MAX_INTERACTIONS) {
        throw new Error(
          "Rendered page exceeds the bounded interactive-control limit"
        );
      }
      interactions.push({
        domIndex,
        tagName: element.tagName.toLowerCase(),
        inputType:
          element.tagName.toLowerCase() === "input"
            ? (getAttribute.call(element, "type") ?? "text").toLowerCase()
            : "",
        ...interaction
      });
      if (interactions.length > MAX_INTERACTION_ACTIONS) {
        throw new Error(
          "Rendered page exceeds the bounded interaction-action limit"
        );
      }
    };
    const canonicalInputValue = (inputType) => {
      switch (inputType) {
        case "text":
        case "search":
          return "BuildLabs proof";
        case "email":
          return "proof@example.invalid";
        case "tel":
          return "5550100";
        case "url":
          return "https://example.invalid";
        case "password":
          return "BuildLabsProof1!";
        case "number":
          return "1";
        case "date":
          return "2026-01-01";
        case "time":
          return "12:00";
        case "month":
          return "2026-01";
        case "week":
          return "2026-W01";
        case "datetime-local":
          return "2026-01-01T12:00";
        default:
          return null;
      }
    };
    const forms = interactionElements.filter(
      (element) => element.tagName.toLowerCase() === "form"
    );
    for (const form of forms) {
      const controls = Array.from(
        querySelectorAllInElement.call(
          form,
          "input,textarea,select,button"
        )
      ).filter((element) => visible(element));
      const radiosHandled = new Set();
      let nextField;
      let submitter;
      for (const control of controls) {
        const tagName = control.tagName.toLowerCase();
        const inputType =
          tagName === "input"
            ? (getAttribute.call(control, "type") ?? "text").toLowerCase()
            : tagName === "button"
              ? (getAttribute.call(control, "type") ?? "submit").toLowerCase()
              : "";
        if (
          (tagName === "button" &&
            (inputType === "submit" || inputType === "")) ||
          (tagName === "input" &&
            (inputType === "submit" || inputType === "image"))
        ) {
          submitter ??= control;
          formOwnedControls.add(control);
          continue;
        }
        if (
          tagName === "button" ||
          (tagName === "input" &&
            (inputType === "button" || inputType === "reset"))
        ) {
          continue;
        }
        formOwnedControls.add(control);
        if (tagName === "input") {
          if (inputType === "hidden") {
            continue;
          }
          if (inputType === "file" || inputType === "color" || inputType === "range") {
            throw new Error(
              "Rendered form contains an unsupported visible input type"
            );
          }
          if (inputType === "checkbox") {
            if (!inputCheckedGetter.call(control) && !nextField) {
              nextField = { element: control, kind: "check", value: "" };
            }
            continue;
          }
          if (inputType === "radio") {
            const group =
              getAttribute.call(control, "name") ||
              "__unnamed-radio-" + interactionIndex.get(control);
            if (radiosHandled.has(group)) {
              continue;
            }
            radiosHandled.add(group);
            const groupControls = controls.filter(
              (candidate) =>
                candidate.tagName.toLowerCase() === "input" &&
                (getAttribute.call(candidate, "type") ?? "text").toLowerCase() ===
                  "radio" &&
                (getAttribute.call(candidate, "name") ||
                  "__unnamed-radio-" + interactionIndex.get(candidate)) === group
            );
            const canonicalRadio = groupControls[0];
            if (
              canonicalRadio &&
              !inputCheckedGetter.call(canonicalRadio) &&
              !nextField
            ) {
              nextField = {
                element: canonicalRadio,
                kind: "check",
                value: ""
              };
            }
            continue;
          }
          const canonicalValue = canonicalInputValue(inputType);
          if (canonicalValue === null) {
            throw new Error(
              "Rendered form contains an unsupported visible input type"
            );
          }
          if (
            inputValueGetter.call(control) !== canonicalValue &&
            !nextField
          ) {
            nextField = {
              element: control,
              kind: "fill",
              value: canonicalValue
            };
          }
          continue;
        }
        if (tagName === "textarea") {
          if (
            textareaValueGetter.call(control) !== "BuildLabs proof" &&
            !nextField
          ) {
            nextField = {
              element: control,
              kind: "fill",
              value: "BuildLabs proof"
            };
          }
          continue;
        }
        if (tagName === "select") {
          const selectableOptions = Array.from(control.options).filter(
            (candidate) => !candidate.disabled
          );
          const option =
            selectableOptions.find((candidate) => candidate.value !== "") ??
            selectableOptions[0];
          if (!option) {
            throw new Error(
              "Rendered form select has no controller-selectable option"
            );
          }
          if (selectValueGetter.call(control) !== option.value && !nextField) {
            nextField = {
              element: control,
              kind: "select",
              value: option.value
            };
          }
        }
      }
      if (nextField) {
        addInteraction(nextField.element, {
          kind: nextField.kind,
          value: nextField.value,
          terminal: false,
          requireObservable: true
        });
      } else if (submitter) {
        addInteraction(submitter, {
          kind: "submit",
          value: "",
          terminal: false,
          requireObservable: true
        });
      } else if (controls.length > 0) {
        addInteraction(form, {
          kind: "submit-form",
          value: "",
          terminal: false,
          requireObservable: true
        });
      }
      if (!nextField) {
        for (const control of controls) {
          const tagName = control.tagName.toLowerCase();
          const inputType =
            tagName === "input"
              ? (getAttribute.call(control, "type") ?? "text").toLowerCase()
              : "";
          if (tagName === "input" && inputType === "checkbox") {
            addInteraction(control, {
              kind: inputCheckedGetter.call(control) ? "uncheck" : "check",
              value: "",
              terminal: false,
              requireObservable: true
            });
          } else if (
            tagName === "input" &&
            inputType === "radio" &&
            !inputCheckedGetter.call(control)
          ) {
            addInteraction(control, {
              kind: "check",
              value: "",
              terminal: false,
              requireObservable: true
            });
          } else if (tagName === "select") {
            for (const option of Array.from(control.options).filter(
              (candidate) =>
                !candidate.disabled &&
                candidate.value !== selectValueGetter.call(control)
            )) {
              addInteraction(control, {
                kind: "select",
                value: option.value,
                terminal: false,
                requireObservable: true
              });
            }
          }
        }
      }
    }
    const hasElementHandler = (element, kind) => {
      const attributeNames =
        kind === "hover"
          ? [
              "onmouseenter",
              "onmouseover",
              "onpointerenter",
              "onpointerover"
            ]
          : ["onfocus", "onfocusin"];
      if (
        attributeNames.some(
          (attribute) => getAttribute.call(element, attribute) !== null
        )
      ) {
        return true;
      }
      try {
        if (
          attributeNames.some(
            (attribute) => typeof element[attribute] === "function"
          )
        ) {
          return true;
        }
        for (const propertyName of Object.getOwnPropertyNames(element)) {
          if (
            !propertyName.startsWith("__reactProps") &&
            propertyName !== "_vei"
          ) {
            continue;
          }
          const handlers = element[propertyName];
          if (!handlers || typeof handlers !== "object") {
            continue;
          }
          const handlerNames =
            kind === "hover"
              ? [
                  "onMouseEnter",
                  "onMouseOver",
                  "onPointerEnter",
                  "onPointerOver"
                ]
              : ["onFocus", "onFocusIn"];
          if (
            handlerNames.some(
              (handlerName) =>
                typeof handlers[handlerName] === "function" ||
                typeof handlers["on" + handlerName.toLowerCase()] ===
                  "function"
            )
          ) {
            return true;
          }
        }
      } catch {
        return true;
      }
      return false;
    };
    const hasAuthoredHoverState = (element) =>
      pseudoTriggerSelectors.hover.some((selector) =>
        matches.call(element, selector)
      );
    const hasAuthoredFocusState = (element) =>
      pseudoTriggerSelectors.focus.some((selector) =>
        matches.call(element, selector)
      ) ||
      pseudoTriggerSelectors.focusWithin.some(
        (selector) => closest.call(element, selector) !== null
    );
    for (const [domIndex, element] of interactionElements.entries()) {
      const tagName = element.tagName.toLowerCase();
      if (!visible(element)) {
        continue;
      }
      const inputType =
        tagName === "input"
          ? (getAttribute.call(element, "type") ?? "text").toLowerCase()
          : tagName === "button"
            ? (
                getAttribute.call(element, "type") ??
                (closest.call(element, "form") ? "submit" : "button")
              ).toLowerCase()
            : "";
      if (!formOwnedControls.has(element)) {
        if (tagName === "a") {
          const rawHref = getAttribute.call(element, "href") ?? "";
          const resolved = new URL(rawHref, document.baseURI);
          const current = new URL(document.URL);
          if (
            resolved.origin === current.origin &&
            resolved.pathname === current.pathname &&
            resolved.search === current.search &&
            (rawHref.trim().startsWith("#") || resolved.hash)
          ) {
            addInteraction(element, {
              kind: "click-fragment",
              value: resolved.hash || "#",
              terminal: false,
              requireObservable: true
            });
          }
        } else if (tagName === "input") {
          if (inputType === "file" || inputType === "color" || inputType === "range") {
            throw new Error(
              "Rendered page contains an unsupported visible input type"
            );
          }
          if (inputType === "checkbox" || inputType === "radio") {
            if (inputType === "checkbox") {
              addInteraction(element, {
                kind: inputCheckedGetter.call(element) ? "uncheck" : "check",
                value: "",
                terminal: false,
                requireObservable: true
              });
            } else if (!inputCheckedGetter.call(element)) {
              addInteraction(element, {
                kind: "check",
                value: "",
                terminal: false,
                requireObservable: true
              });
            }
          } else if (inputType === "button") {
            addInteraction(element, {
              kind: "click",
              value: "",
              terminal: false,
              requireObservable: true
            });
          } else if (
            inputType !== "hidden" &&
            inputType !== "submit" &&
            inputType !== "reset" &&
            inputType !== "image"
          ) {
            const canonicalValue = canonicalInputValue(inputType);
            if (canonicalValue === null) {
              throw new Error(
                "Rendered page contains an unsupported visible input type"
              );
            }
            if (inputValueGetter.call(element) !== canonicalValue) {
              addInteraction(element, {
                kind: "fill",
                value: canonicalValue,
                terminal: false,
                requireObservable: true
              });
            }
          } else if (inputType === "submit" || inputType === "image") {
            addInteraction(element, {
              kind: "submit",
              value: "",
              terminal: false,
              requireObservable: true
            });
          }
        } else if (tagName === "textarea") {
          if (textareaValueGetter.call(element) !== "BuildLabs proof") {
            addInteraction(element, {
              kind: "fill",
              value: "BuildLabs proof",
              terminal: false,
              requireObservable: true
            });
          }
        } else if (tagName === "select") {
          const options = Array.from(element.options).filter(
            (candidate) => !candidate.disabled
          );
          if (options.length === 0) {
            throw new Error(
              "Rendered page select has no controller-selectable option"
            );
          }
          for (const option of options.filter(
            (candidate) =>
              candidate.value !== selectValueGetter.call(element)
          )) {
            addInteraction(element, {
              kind: "select",
              value: option.value,
              terminal: false,
              requireObservable: true
            });
          }
        } else if (
          tagName === "button" ||
          tagName === "summary" ||
          getAttribute.call(element, "role") === "button"
        ) {
          if (inputType !== "submit" && inputType !== "reset") {
            addInteraction(element, {
              kind: "click",
              value: "",
              terminal: false,
              requireObservable: true
            });
          }
        }
      }
      const focusable =
        tagName === "a" ||
        tagName === "button" ||
        tagName === "summary" ||
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        getAttribute.call(element, "tabindex") !== null ||
        getAttribute.call(element, "role") === "button";
      const hoverHasHandler = hasElementHandler(element, "hover");
      if (hasAuthoredHoverState(element) || hoverHasHandler) {
        addInteraction(element, {
          kind: "hover",
          value: "",
          terminal: !hoverHasHandler,
          requireObservable: hoverHasHandler
        });
      }
      const focusHasHandler = hasElementHandler(element, "focus");
      if (
        focusable &&
        (hasAuthoredFocusState(element) || focusHasHandler)
      ) {
        addInteraction(element, {
          kind: "focus",
          value: "",
          terminal: !focusHasHandler,
          requireObservable: focusHasHandler
        });
      }
      if (domIndex !== interactionIndex.get(element)) {
        throw new Error("Rendered-page interaction ordering is invalid");
      }
    }
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth
    );
    const documentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    return {
      candidates,
      outerHTML,
      anchorHrefs,
      interactions,
      state: {
        url: document.URL,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewportWidth: document.documentElement.clientWidth,
        viewportHeight: document.documentElement.clientHeight,
        documentWidth,
        documentHeight
      }
    };
}

async function collectCandidateState(instrumentation) {
  const response = await instrumentation.session.send("Runtime.evaluate", {
    expression:
      "(" + collectCandidateStateInIsolatedWorld.toString() + ")()",
    contextId: instrumentation.executionContextId,
    returnByValue: true,
    awaitPromise: false,
    silent: true,
    timeout: 5000,
    disableBreaks: true
  });
  const collected = response.result?.value;
  if (
    response.exceptionDetails ||
    !collected ||
    typeof collected !== "object" ||
    !Array.isArray(collected.candidates) ||
    typeof collected.outerHTML !== "string" ||
    !Array.isArray(collected.anchorHrefs) ||
    collected.anchorHrefs.some(
      (href) => typeof href !== "string" || href.length > 4000
    ) ||
    !Array.isArray(collected.interactions) ||
    collected.interactions.length > MAX_INTERACTION_ACTIONS ||
    collected.interactions.some(
      (interaction) =>
        !interaction ||
        typeof interaction !== "object" ||
        !Number.isSafeInteger(interaction.domIndex) ||
        typeof interaction.tagName !== "string" ||
        typeof interaction.inputType !== "string" ||
        ![
          "check",
          "click",
          "click-fragment",
          "fill",
          "focus",
          "hover",
          "select",
          "submit",
          "submit-form",
          "uncheck"
        ].includes(interaction.kind) ||
        typeof interaction.value !== "string" ||
        typeof interaction.terminal !== "boolean" ||
        typeof interaction.requireObservable !== "boolean"
    ) ||
    !collected.state ||
    typeof collected.state !== "object" ||
    !Number.isSafeInteger(collected.state.documentWidth) ||
    !Number.isSafeInteger(collected.state.documentHeight)
  ) {
    fail("Isolated rendered-page state collection failed");
  }
  return collected;
}

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    buffer.length < 33 ||
    !buffer.subarray(0, signature.length).equals(signature)
  ) {
    fail("Rendered-page screenshot is not a PNG");
  }
  let offset = signature.length;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const compressed = [];
  let compressedBytes = 0;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      fail("Rendered-page screenshot has a truncated PNG chunk");
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (length !== 13) {
        fail("Rendered-page screenshot has an invalid PNG header");
      }
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      compressedBytes += data.length;
      if (compressedBytes > 20 * 1024 * 1024) {
        fail("Rendered-page screenshot exceeds the compressed PNG limit");
      }
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (
    width !== 1440 ||
    height !== 900 ||
    bitDepth !== 8 ||
    (colorType !== 2 && colorType !== 6) ||
    interlace !== 0 ||
    compressed.length === 0
  ) {
    fail("Rendered-page screenshot has an unsupported PNG layout");
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const expectedBytes = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: expectedBytes
  });
  if (raw.length !== expectedBytes) {
    fail("Rendered-page screenshot has an invalid decoded size");
  }
  const unfiltered = Buffer.allocUnsafe(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * stride;
    const previousRowOffset = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[sourceOffset + x];
      const left = x >= bytesPerPixel
        ? unfiltered[rowOffset + x - bytesPerPixel]
        : 0;
      const above = y > 0 ? unfiltered[previousRowOffset + x] : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel
          ? unfiltered[previousRowOffset + x - bytesPerPixel]
          : 0;
      let value;
      if (filter === 0) {
        value = encoded;
      } else if (filter === 1) {
        value = encoded + left;
      } else if (filter === 2) {
        value = encoded + above;
      } else if (filter === 3) {
        value = encoded + Math.floor((left + above) / 2);
      } else if (filter === 4) {
        value = encoded + paethPredictor(left, above, upperLeft);
      } else {
        fail("Rendered-page screenshot uses an invalid PNG filter");
      }
      unfiltered[rowOffset + x] = value & 255;
    }
    sourceOffset += stride;
  }
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let source = 0, target = 0; source < unfiltered.length; ) {
    rgba[target] = unfiltered[source];
    rgba[target + 1] = unfiltered[source + 1];
    rgba[target + 2] = unfiltered[source + 2];
    rgba[target + 3] = colorType === 6 ? unfiltered[source + 3] : 255;
    source += bytesPerPixel;
    target += 4;
  }
  return { width, height, data: rgba };
}

function pixelLuminance(red, green, blue) {
  const channels = [red, green, blue].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  );
}

function contrastRatio(left, right) {
  const leftLuminance = pixelLuminance(left[0], left[1], left[2]);
  const rightLuminance = pixelLuminance(right[0], right[1], right[2]);
  const brightest = Math.max(leftLuminance, rightLuminance);
  const darkest = Math.min(leftLuminance, rightLuminance);
  return (brightest + 0.05) / (darkest + 0.05);
}

function candidateHasReadablePixels(
  candidate,
  baselineBefore,
  hidden,
  baselineAfter
) {
  let inspectedPixels = 0;
  let readablePixels = 0;
  for (const rect of candidate.rects) {
    const left = Math.max(0, Math.floor(rect.left));
    const top = Math.max(0, Math.floor(rect.top));
    const right = Math.min(baselineBefore.width, Math.ceil(rect.right));
    const bottom = Math.min(baselineBefore.height, Math.ceil(rect.bottom));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        inspectedPixels += 1;
        const offset = (y * baselineBefore.width + x) * 4;
        const before = baselineBefore.data.subarray(offset, offset + 3);
        const after = baselineAfter.data.subarray(offset, offset + 3);
        if (
          Math.abs(before[0] - after[0]) <= 2 &&
          Math.abs(before[1] - after[1]) <= 2 &&
          Math.abs(before[2] - after[2]) <= 2 &&
          contrastRatio(
            before,
            hidden.data.subarray(offset, offset + 3)
          ) >= 3
        ) {
          readablePixels += 1;
        }
      }
    }
  }
  return hasSufficientReadablePixelEvidence({
    visibleAreaRatio: candidate.visibleAreaRatio,
    inspectedPixels,
    readablePixels
  });
}

function candidateReadableText(
  candidate,
  baselineBefore,
  hidden,
  baselineAfter
) {
  return assembleReadableGraphemeText(
    candidate.segments.map((segment) => ({
      text: segment.text,
      whitespace: segment.whitespace,
      readable:
        !segment.whitespace &&
        candidateHasReadablePixels(
          segment,
          baselineBefore,
          hidden,
          baselineAfter
        )
    }))
  );
}

function summarizePixelDifference(expectedBuffer, actualBuffer) {
  let differingBytes = Math.abs(expectedBuffer.length - actualBuffer.length);
  const comparableBytes = Math.min(expectedBuffer.length, actualBuffer.length);
  for (let index = 0; index < comparableBytes; index += 1) {
    if (expectedBuffer[index] !== actualBuffer[index]) {
      differingBytes += 1;
    }
  }
  const expected = decodePng(expectedBuffer);
  const actual = decodePng(actualBuffer);
  if (expected.width !== actual.width || expected.height !== actual.height) {
    fail("Rendered-page baseline recapture dimensions changed");
  }
  let differingPixels = 0;
  let maxChannelDelta = 0;
  for (let offset = 0; offset < expected.data.length; offset += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        expected.data[offset + channel] - actual.data[offset + channel]
      );
      if (delta > 0) {
        pixelDiffers = true;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
      }
    }
    if (pixelDiffers) {
      differingPixels += 1;
    }
  }
  return { differingBytes, differingPixels, maxChannelDelta };
}

async function collectVisibleText(
  page,
  candidates,
  instrumentation,
  baselineBuffer,
  deadline
) {
  const marker = "data-buildlabs-text-" + randomBytes(12).toString("hex");
  const { styleSheetId } = await instrumentation.session.send(
    "CSS.createStyleSheet",
    {
      frameId: instrumentation.frameId,
      force: true
    }
  );
  const hiddenTextStyle =
    ":root, :root * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; fill: transparent !important; stroke: transparent !important; }";
  let markerApplied = false;
  let styleApplied = false;
  let hiddenBuffer;
  try {
    await instrumentation.session.send("DOM.setAttributeValue", {
      nodeId: instrumentation.bodyNodeId,
      name: marker,
      value: ""
    });
    markerApplied = true;
    await instrumentation.session.send("CSS.setStyleSheetText", {
      styleSheetId,
      text: hiddenTextStyle
    });
    styleApplied = true;
    hiddenBuffer = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png"
    });
  } finally {
    if (styleApplied) {
      await instrumentation.session
        .send("CSS.setStyleSheetText", {
          styleSheetId,
          text: ""
        })
        .catch(() => undefined);
    }
    if (markerApplied) {
      await instrumentation.session
        .send("DOM.removeAttribute", {
          nodeId: instrumentation.bodyNodeId,
          name: marker
        })
        .catch(() => undefined);
    }
  }
  const baselineAfterBuffer = await recaptureExactPixelBaseline(
    page,
    baselineBuffer,
    deadline,
    summarizePixelDifference
  );
  const baselineBefore = decodePng(baselineBuffer);
  const hidden = decodePng(hiddenBuffer);
  const baselineAfter = decodePng(baselineAfterBuffer);
  if (
    baselineBefore.width !== hidden.width ||
    baselineBefore.height !== hidden.height ||
    baselineBefore.width !== baselineAfter.width ||
    baselineBefore.height !== baselineAfter.height ||
    baselineBefore.width !== 1440 ||
    baselineBefore.height !== 900
  ) {
    fail("Rendered-page screenshots have unexpected dimensions");
  }
  const visibleText = candidates
    .map((candidate) =>
      candidateReadableText(
        candidate,
        baselineBefore,
        hidden,
        baselineAfter
      )
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    visibleText,
    screenshotSha256: createHash("sha256").update(baselineBuffer).digest("hex"),
    screenshotBase64: baselineBuffer.toString("base64")
  };
}

async function prepareProofInstrumentation(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    await session.send("Runtime.enable");
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send(
      "Page.createIsolatedWorld",
      {
        frameId: frameTree.frame.id,
        worldName:
          "buildlabs-proof-" + randomBytes(12).toString("hex")
      }
    );
    const { root } = await session.send("DOM.getDocument", {
      depth: 1,
      pierce: false
    });
    const [{ nodeId: documentElementNodeId }, { nodeId: bodyNodeId }] =
      await Promise.all([
        session.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: "html"
        }),
        session.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: "body"
        })
      ]);
    if (!documentElementNodeId || !bodyNodeId) {
      fail("Rendered-page proof could not resolve the candidate document");
    }
    return {
      session,
      frameId: frameTree.frame.id,
      executionContextId,
      documentNodeId: root.nodeId,
      documentElementNodeId,
      bodyNodeId
    };
  } catch (error) {
    await session.detach().catch(() => undefined);
    throw error;
  }
}

async function freezeAndVerifyCandidateState(
  page,
  instrumentation,
  collected,
  preCollectionBuffer
) {
  await instrumentation.session.send(
    "Emulation.setScriptExecutionDisabled",
    {
      value: true
    }
  );
  const [{ outerHTML }, urlResult, layoutMetrics] = await Promise.all([
    instrumentation.session.send("DOM.getOuterHTML", {
      nodeId: instrumentation.documentElementNodeId
    }),
    instrumentation.session.send("Runtime.evaluate", {
      expression: "document.URL",
      contextId: instrumentation.executionContextId,
      returnByValue: true,
      awaitPromise: false,
      silent: true,
      timeout: 2000,
      disableBreaks: true
    }),
    instrumentation.session.send("Page.getLayoutMetrics")
  ]);
  if (Buffer.byteLength(outerHTML, "utf8") > 1000000) {
    fail("Frozen rendered page exceeds the bounded DOM snapshot limit");
  }
  const frozenState = {
    url: urlResult.result?.value,
    scrollX: layoutMetrics.cssLayoutViewport.pageX,
    scrollY: layoutMetrics.cssLayoutViewport.pageY,
    viewportWidth: layoutMetrics.cssLayoutViewport.clientWidth,
    viewportHeight: layoutMetrics.cssLayoutViewport.clientHeight,
    documentWidth: Math.ceil(layoutMetrics.cssContentSize.width),
    documentHeight: Math.ceil(layoutMetrics.cssContentSize.height)
  };
  if (
    outerHTML !== collected.outerHTML ||
    JSON.stringify(frozenState) !== JSON.stringify(collected.state)
  ) {
    fail("Rendered-page DOM changed across the script-freeze boundary");
  }
  const frozenBaselineBuffer = await page.screenshot({
    animations: "disabled",
    caret: "hide",
    scale: "css",
    type: "png"
  });
  if (!frozenBaselineBuffer.equals(preCollectionBuffer)) {
    fail("Rendered-page pixels changed across the script-freeze boundary");
  }
  return {
    ...instrumentation,
    baselineBuffer: frozenBaselineBuffer
  };
}

async function scrollDocumentTo(
  instrumentation,
  targetY,
  documentHeight,
  viewportHeight
) {
  if (
    !Number.isSafeInteger(targetY) ||
    targetY < 0 ||
    targetY > documentHeight - viewportHeight
  ) {
    fail("Rendered-page scroll target is invalid");
  }
  await instrumentation.session.send("DOM.scrollIntoViewIfNeeded", {
    nodeId: instrumentation.documentElementNodeId,
    rect: {
      x: 0,
      y: targetY,
      width: 1,
      height: viewportHeight
    }
  });
  const metrics = await instrumentation.session.send("Page.getLayoutMetrics");
  if (
    Math.abs(metrics.cssLayoutViewport.pageX) > 0.5 ||
    Math.abs(metrics.cssLayoutViewport.pageY - targetY) > 0.5
  ) {
    fail("Rendered-page proof could not reach an exact scroll tile");
  }
}

async function collectProofTiles(page, instrumentation, deadline) {
  const capture = async () => {
    if (Date.now() >= deadline) {
      fail("Rendered-page inspection exceeded its total timeout");
    }
    const baselineBuffer = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png"
    });
    const collected = await collectCandidateState(instrumentation);
    return { baselineBuffer, collected };
  };
  const first = await capture();
  const { state } = first.collected;
  if (
    state.scrollX !== 0 ||
    state.scrollY !== 0 ||
    state.viewportWidth !== 1440 ||
    state.viewportHeight !== 900 ||
    state.documentWidth > state.viewportWidth ||
    state.documentHeight < state.viewportHeight ||
    state.documentHeight > MAX_DOCUMENT_HEIGHT
  ) {
    fail("Rendered page exceeds the bounded full-page viewport");
  }
  const offsets = planScrollTileOffsets(
    state.documentHeight,
    state.viewportHeight,
    MAX_SCROLL_TILES
  );
  const tiles = [{ offset: 0, ...first }];
  for (const offset of offsets.slice(1)) {
    await scrollDocumentTo(
      instrumentation,
      offset,
      state.documentHeight,
      state.viewportHeight
    );
    const tile = await capture();
    if (
      tile.collected.outerHTML !== first.collected.outerHTML ||
      tile.collected.state.url !== state.url ||
      tile.collected.state.scrollX !== 0 ||
      Math.abs(tile.collected.state.scrollY - offset) > 0.5 ||
      tile.collected.state.viewportWidth !== state.viewportWidth ||
      tile.collected.state.viewportHeight !== state.viewportHeight ||
      tile.collected.state.documentWidth !== state.documentWidth ||
      tile.collected.state.documentHeight !== state.documentHeight
    ) {
      fail("Rendered-page DOM changed during bounded full-page collection");
    }
    tiles.push({ offset, ...tile });
  }
  if (offsets.length > 1) {
    await scrollDocumentTo(
      instrumentation,
      0,
      state.documentHeight,
      state.viewportHeight
    );
    const restoredBuffer = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png"
    });
    if (!restoredBuffer.equals(first.baselineBuffer)) {
      fail("Rendered-page pixels changed during bounded full-page collection");
    }
  }
  return tiles;
}

async function inspectFrozenTiles(
  page,
  instrumentation,
  tiles,
  deadline,
  parentCapture
) {
  const visibleTextParts = [];
  const screenshotSha256s = [];
  const screenshotBase64s = [];
  const tileProofs = [];
  const firstState = tiles[0].collected.state;
  for (const tile of tiles) {
    if (Date.now() >= deadline) {
      fail("Rendered-page inspection exceeded its total timeout");
    }
    await scrollDocumentTo(
      instrumentation,
      tile.offset,
      firstState.documentHeight,
      firstState.viewportHeight
    );
    const [{ outerHTML }, urlResult, layoutMetrics] = await Promise.all([
      instrumentation.session.send("DOM.getOuterHTML", {
        nodeId: instrumentation.documentElementNodeId
      }),
      instrumentation.session.send("Runtime.evaluate", {
        expression: "document.URL",
        contextId: instrumentation.executionContextId,
        returnByValue: true,
        awaitPromise: false,
        silent: true,
        timeout: 2000,
        disableBreaks: true
      }),
      instrumentation.session.send("Page.getLayoutMetrics")
    ]);
    const frozenState = {
      url: urlResult.result?.value,
      scrollX: layoutMetrics.cssLayoutViewport.pageX,
      scrollY: layoutMetrics.cssLayoutViewport.pageY,
      viewportWidth: layoutMetrics.cssLayoutViewport.clientWidth,
      viewportHeight: layoutMetrics.cssLayoutViewport.clientHeight,
      documentWidth: Math.ceil(layoutMetrics.cssContentSize.width),
      documentHeight: Math.ceil(layoutMetrics.cssContentSize.height)
    };
    if (
      outerHTML !== tile.collected.outerHTML ||
      JSON.stringify(frozenState) !== JSON.stringify(tile.collected.state)
    ) {
      fail("Rendered-page DOM changed across the frozen scroll-tile boundary");
    }
    const frozenBaselineBuffer = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png"
    });
    if (!frozenBaselineBuffer.equals(tile.baselineBuffer)) {
      fail("Rendered-page pixels changed across the frozen scroll-tile boundary");
    }
    const parentTileIndex = parentCapture
      ? parentCapture.tiles.findIndex(
          (candidate) => candidate.offset === tile.offset
        )
      : -1;
    const parentTile =
      parentTileIndex >= 0
        ? parentCapture.tiles[parentTileIndex]
        : undefined;
    const parentTileProof =
      parentTileIndex >= 0
        ? parentCapture.inspection.tileProofs[parentTileIndex]
        : undefined;
    const reusable =
      parentTile &&
      parentTileProof &&
      canReuseRenderedTileProof(
        {
          offset: tile.offset,
          viewportWidth: tile.collected.state.viewportWidth,
          viewportHeight: tile.collected.state.viewportHeight,
          documentWidth: tile.collected.state.documentWidth,
          documentHeight: tile.collected.state.documentHeight
        },
        {
          offset: parentTile.offset,
          viewportWidth: parentTile.collected.state.viewportWidth,
          viewportHeight: parentTile.collected.state.viewportHeight,
          documentWidth: parentTile.collected.state.documentWidth,
          documentHeight: parentTile.collected.state.documentHeight
        },
        frozenBaselineBuffer.equals(parentTile.baselineBuffer),
        JSON.stringify(tile.collected.candidates) ===
          JSON.stringify(parentTile.collected.candidates)
      );
    const inspected = reusable
      ? parentTileProof
      : await collectVisibleText(
          page,
          tile.collected.candidates,
          instrumentation,
          frozenBaselineBuffer,
          deadline
        );
    if (inspected.visibleText) {
      visibleTextParts.push(inspected.visibleText);
    }
    screenshotSha256s.push(inspected.screenshotSha256);
    screenshotBase64s.push(inspected.screenshotBase64);
    tileProofs.push({
      offset: tile.offset,
      visibleText: inspected.visibleText,
      screenshotSha256: inspected.screenshotSha256,
      screenshotBase64: inspected.screenshotBase64
    });
  }
  return {
    visibleText: visibleTextParts.join(" ").replace(/\s+/g, " ").trim(),
    screenshotSha256s,
    screenshotBase64s,
    tileProofs
  };
}

async function openProofPage(
  browser,
  target,
  origin,
  port,
  timeout,
  allowInitialWebSockets = false
) {
  const networkState = {
    blockedAfterLoad: false,
    blockedAttemptCount: 0,
    blockedAttemptKinds: new Set()
  };
  const recordBlockedAttempt = (kind) => {
    networkState.blockedAttemptCount += 1;
    networkState.blockedAttemptKinds.add(kind);
  };
  const assertNoBlockedAttempts = () => {
    if (networkState.blockedAttemptCount > 0) {
      fail(
        "Rendered-page interaction attempted blocked network access (" +
          Array.from(networkState.blockedAttemptKinds).sort().join(",") +
          ")"
      );
    }
  };
  const context = await browser.newContext({
    acceptDownloads: false,
    javaScriptEnabled: true,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce"
  });
  let page;
  try {
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    await context.route("**/*", async (route) => {
      const decision = decideProofNetworkRequest({
        kind: "http",
        blockedAfterLoad: networkState.blockedAfterLoad,
        allowedUrl: isAllowedHttpUrl(route.request().url(), origin),
        allowInitialWebSockets
      });
      if (decision === "allow") {
        await route.continue();
      } else {
        if (decision === "block-post-load") {
          recordBlockedAttempt("http");
        }
        await route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket("**/*", async (socket) => {
      const decision = decideProofNetworkRequest({
        kind: "websocket",
        blockedAfterLoad: networkState.blockedAfterLoad,
        allowedUrl: isAllowedWebSocketUrl(socket.url(), port),
        allowInitialWebSockets
      });
      if (decision === "allow") {
        socket.connectToServer();
      } else {
        if (
          decision === "block-post-load" ||
          decision === "block-initial-websocket"
        ) {
          recordBlockedAttempt("websocket");
        }
        await socket.close({
          code: 1008,
          reason: "Sockets are blocked during proof interactions"
        });
      }
    });
    context.on("page", (openedPage) => {
      if (page && openedPage !== page) {
        void openedPage.close();
      }
    });
    page = await context.newPage();
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    const response = await page.goto(target.href, {
      waitUntil: "load",
      timeout
    });
    if (!response) {
      fail("Rendered page returned no HTTP response");
    }
    if (!isAllowedHttpUrl(page.url(), origin)) {
      fail("Rendered page navigated away from the preview origin");
    }
    assertNoBlockedAttempts();
    const mediaType = (
      (await response.headerValue("content-type")) ?? ""
    )
      .split(";")[0]
      .trim()
      .toLowerCase();
    const contentDisposition = (
      (await response.headerValue("content-disposition")) ?? ""
    ).toLowerCase();
    const isBrowserTextDocument =
      !mediaType ||
      mediaType.startsWith("text/") ||
      mediaType === "application/xhtml+xml" ||
      mediaType === "application/json" ||
      mediaType.endsWith("+json") ||
      mediaType === "application/xml" ||
      mediaType.endsWith("+xml");
    networkState.blockedAfterLoad = true;
    return {
      context,
      page,
      response,
      networkState,
      assertNoBlockedAttempts,
      nonHtmlMediaType:
        contentDisposition.includes("attachment") ||
        !isBrowserTextDocument
          ? mediaType || "application/octet-stream"
          : null
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

async function captureFrozenPage(
  page,
  deadline,
  instrumentation,
  parentCapture
) {
  const activeInstrumentation =
    instrumentation ?? (await prepareProofInstrumentation(page));
  const tiles = await collectProofTiles(
    page,
    activeInstrumentation,
    deadline
  );
  const firstTile = tiles[0];
  const frozen = await freezeAndVerifyCandidateState(
    page,
    activeInstrumentation,
    firstTile.collected,
    firstTile.baselineBuffer
  );
  const inspection = await inspectFrozenTiles(
    page,
    frozen,
    tiles,
    deadline,
    parentCapture
  );
  return {
    instrumentation: activeInstrumentation,
    firstTile,
    inspection,
    tiles
  };
}

function frozenInteractionStateDigest(capture) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        url: capture.firstTile.collected.state.url,
        outerHTML: capture.firstTile.collected.outerHTML,
        visibleText: capture.inspection.visibleText,
        screenshotSha256s: capture.inspection.screenshotSha256s
      })
    )
    .digest("hex");
}

function frozenInteractionSemanticDigest(capture) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        url: capture.firstTile.collected.state.url,
        outerHTML: capture.firstTile.collected.outerHTML,
        visibleText: capture.inspection.visibleText,
        interactions: capture.firstTile.collected.interactions
      })
    )
    .digest("hex");
}

async function performProofInteraction(
  actionPage,
  instrumentation,
  interaction,
  deadline
) {
  const locator = actionPage.page
    .locator(INTERACTION_SELECTOR)
    .nth(interaction.domIndex);
  const timeout = Math.max(
    1000,
    Math.min(5000, deadline - Date.now())
  );
  switch (interaction.kind) {
    case "check":
      await locator.check({ timeout });
      break;
    case "click":
    case "submit":
      await locator.click({ timeout, noWaitAfter: true });
      break;
    case "click-fragment":
      await locator.click({ timeout, noWaitAfter: true });
      await instrumentation.session.send("Runtime.evaluate", {
        expression:
          "History.prototype.replaceState.call(history, null, '', " +
          JSON.stringify(interaction.value) +
          ")",
        contextId: instrumentation.executionContextId,
        returnByValue: true,
        awaitPromise: false,
        silent: true,
        timeout: 2000,
        disableBreaks: true
      });
      break;
    case "fill":
      await locator.fill(interaction.value, { timeout });
      break;
    case "focus":
      await locator.focus({ timeout });
      break;
    case "hover": {
      await locator.hover({ timeout });
      const { nodeIds } = await instrumentation.session.send(
        "DOM.querySelectorAll",
        {
          nodeId: instrumentation.documentNodeId,
          selector: INTERACTION_SELECTOR
        }
      );
      const nodeId = nodeIds[interaction.domIndex];
      if (!nodeId) {
        fail("Rendered-page hover target could not be frozen");
      }
      await instrumentation.session.send("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: ["hover"]
      });
      break;
    }
    case "select":
      await locator.selectOption(
        { value: interaction.value },
        { timeout }
      );
      break;
    case "submit-form":
      await locator.evaluate((form) => {
        HTMLFormElement.prototype.requestSubmit.call(form);
      });
      break;
    case "uncheck":
      await locator.uncheck({ timeout });
      break;
    default:
      fail("Rendered-page interaction action is unsupported");
  }
}

async function inspectPath(browser, input, path, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 1000) {
    return { path, status: null, error: "Rendered-page inspection exceeded its total timeout" };
  }
  const perPathTimeout = Math.max(
    1000,
    Math.min(60000, remaining)
  );
  const origin = "http://127.0.0.1:" + input.port;
  const target = new URL(path, origin);
  let baselinePage;
  let baselineInstrumentation;
  try {
    baselinePage = await openProofPage(
      browser,
      target,
      origin,
      input.port,
      perPathTimeout
    );
    if (baselinePage.nonHtmlMediaType) {
      return {
        path,
        status: baselinePage.response.status(),
        nonHtmlMediaType: baselinePage.nonHtmlMediaType,
        links: []
      };
    }
    await baselinePage.page.waitForTimeout(250);
    baselinePage.assertNoBlockedAttempts();
    const baseline = await captureFrozenPage(
      baselinePage.page,
      deadline
    );
    baselinePage.assertNoBlockedAttempts();
    baselineInstrumentation = baseline.instrumentation;
    const baselineInteractions =
      baseline.firstTile.collected.interactions;
    const visibleTextParts = [];
    const visibleTextStates = new Set();
    const screenshotSha256s = [];
    const screenshotBase64s = [];
    const screenshotDigests = new Set();
    const appendInspectionEvidence = (inspection) => {
      if (
        inspection.visibleText &&
        !visibleTextStates.has(inspection.visibleText)
      ) {
        visibleTextStates.add(inspection.visibleText);
        visibleTextParts.push(inspection.visibleText);
      }
      for (const tileProof of inspection.tileProofs) {
        if (screenshotDigests.has(tileProof.screenshotSha256)) {
          continue;
        }
        screenshotDigests.add(tileProof.screenshotSha256);
        screenshotSha256s.push(tileProof.screenshotSha256);
        screenshotBase64s.push(tileProof.screenshotBase64);
      }
    };
    appendInspectionEvidence(baseline.inspection);
    const anchorHrefs = [
      ...baseline.firstTile.collected.anchorHrefs
    ];
    const status = baselinePage.response.status();
    await baselineInstrumentation.session.detach().catch(() => undefined);
    baselineInstrumentation = undefined;
    await baselinePage.context.close();
    baselinePage = undefined;

    const baselineStateDigest =
      frozenInteractionStateDigest(baseline);
    const baselineSemanticDigest =
      frozenInteractionSemanticDigest(baseline);
    const seenInteractionStates = new Set([baselineStateDigest]);
    const seenTerminalInteractionStates = new Set();
    const interactionQueue = [
      {
        sequence: [],
        interactions: baselineInteractions,
        stateDigest: baselineStateDigest,
        semanticDigest: baselineSemanticDigest,
        capture: baseline
      }
    ];
    let interactionTransitions = 0;
    for (
      let stateIndex = 0;
      stateIndex < interactionQueue.length;
      stateIndex += 1
    ) {
      const state = interactionQueue[stateIndex];
      for (const interaction of state.interactions) {
        if (
          (interaction.terminal && stateIndex > 0) ||
          state.sequence.some(
            (step) =>
              step.domIndex === interaction.domIndex &&
              step.kind === interaction.kind &&
              step.value === interaction.value
          )
        ) {
          continue;
        }
        interactionTransitions += 1;
        if (
          interactionTransitions > MAX_INTERACTION_TRANSITIONS ||
          Date.now() >= deadline
        ) {
          fail(
            "Rendered-page interaction state exploration exceeded its bound"
          );
        }
        const sequence = [
          ...state.sequence,
          {
            domIndex: interaction.domIndex,
            kind: interaction.kind,
            value: interaction.value,
            expectedInteractions: JSON.stringify(state.interactions)
          }
        ];
        let actionPage;
        let actionInstrumentation;
        try {
          actionPage = await openProofPage(
            browser,
            target,
            origin,
            input.port,
            Math.max(1000, Math.min(15000, deadline - Date.now())),
            false
          );
          if (actionPage.nonHtmlMediaType) {
            fail(
              "Rendered-page interaction reload returned non-HTML content"
            );
          }
          await actionPage.page.waitForTimeout(250);
          actionPage.assertNoBlockedAttempts();
          actionInstrumentation = await prepareProofInstrumentation(
            actionPage.page
          );
          await actionPage.page.screenshot({
            animations: "disabled",
            caret: "hide",
            scale: "css",
            type: "png"
          });
          const initialActionState = await collectCandidateState(
            actionInstrumentation
          );
          const freshDomMatches =
            initialActionState.outerHTML ===
            baseline.firstTile.collected.outerHTML;
          const freshInteractionsMatch =
            JSON.stringify(initialActionState.interactions) ===
            JSON.stringify(baselineInteractions);
          if (!freshDomMatches || !freshInteractionsMatch) {
            fail(
              "Rendered-page interactive controls changed across fresh state " +
                "(dom=" +
                String(freshDomMatches) +
                ",controls=" +
                String(freshInteractionsMatch) +
                ")"
            );
          }
          await actionInstrumentation.session.send("Runtime.evaluate", {
            expression:
              "(() => { const add = EventTarget.prototype.addEventListener; add.call(document, 'submit', (event) => event.preventDefault(), true); add.call(document, 'click', (event) => { const target = event.target; if (target instanceof Element && Element.prototype.closest.call(target, 'a[href]')) event.preventDefault(); }, true); })()",
            contextId: actionInstrumentation.executionContextId,
            returnByValue: true,
            awaitPromise: false,
            silent: true,
            timeout: 2000,
            disableBreaks: true
          });
          actionPage.assertNoBlockedAttempts();
          let replayState = initialActionState;
          for (const step of sequence) {
            if (
              JSON.stringify(replayState.interactions) !==
              step.expectedInteractions
            ) {
              fail(
                "Rendered-page interaction sequence was not deterministic"
              );
            }
            const replayInteraction = replayState.interactions.find(
              (candidate) =>
                candidate.domIndex === step.domIndex &&
                candidate.kind === step.kind &&
                candidate.value === step.value
            );
            if (!replayInteraction) {
              fail(
                "Rendered-page interaction sequence target changed across fresh state"
              );
            }
            await performProofInteraction(
              actionPage,
              actionInstrumentation,
              replayInteraction,
              deadline
            );
            await actionPage.page.waitForTimeout(250);
            actionPage.assertNoBlockedAttempts();
            const actionUrl = new URL(actionPage.page.url());
            if (
              !isAllowedHttpUrl(actionUrl.href, origin) ||
              actionUrl.pathname + actionUrl.search !==
                target.pathname + target.search
            ) {
              fail(
                "Rendered-page interaction navigated away from its inspected route"
              );
            }
            await actionPage.page.screenshot({
              animations: "disabled",
              caret: "hide",
              scale: "css",
              type: "png"
            });
            replayState = await collectCandidateState(
              actionInstrumentation
            );
          }
          await scrollDocumentTo(
            actionInstrumentation,
            0,
            replayState.state.documentHeight,
            replayState.state.viewportHeight
          );
          const action = await captureFrozenPage(
            actionPage.page,
            deadline,
            actionInstrumentation,
            state.capture
          );
          const stateDigest = frozenInteractionStateDigest(action);
          const semanticDigest =
            frozenInteractionSemanticDigest(action);
          actionPage.assertNoBlockedAttempts();
          if (interaction.requireObservable) {
            assertObservableInteractionTransition(
              state.semanticDigest,
              semanticDigest
            );
          } else if (state.stateDigest === stateDigest) {
            continue;
          }
          if (interaction.terminal) {
            if (
              seenInteractionStates.has(stateDigest) ||
              seenTerminalInteractionStates.has(stateDigest)
            ) {
              continue;
            }
            if (
              seenTerminalInteractionStates.size >=
              MAX_TERMINAL_INTERACTION_STATES
            ) {
              fail(
                "Rendered-page terminal interaction states exceed the bounded state limit"
              );
            }
            seenTerminalInteractionStates.add(stateDigest);
          } else {
            if (seenInteractionStates.has(stateDigest)) {
              continue;
            }
            if (
              seenInteractionStates.size >= MAX_INTERACTION_STATES
            ) {
              fail(
                "Rendered-page interaction states exceed the bounded state limit"
              );
            }
            seenInteractionStates.add(stateDigest);
          }
          appendInspectionEvidence(action.inspection);
          anchorHrefs.push(
            ...action.firstTile.collected.anchorHrefs
          );
          if (
            screenshotSha256s.length >
            MAX_SCREENSHOT_TILES_PER_ROUTE
          ) {
            fail(
              "Rendered-page interaction states exceed the bounded screenshot-tile limit"
            );
          }
          if (interaction.terminal) {
            continue;
          }
          interactionQueue.push({
            sequence,
            interactions:
              action.firstTile.collected.interactions,
            stateDigest,
            semanticDigest,
            capture: action
          });
        } finally {
          await actionInstrumentation?.session
            .detach()
            .catch(() => undefined);
          await actionPage?.context.close().catch(() => undefined);
        }
      }
    }

    const visibleText = visibleTextParts
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (Buffer.byteLength(visibleText, "utf8") > MAX_TEXT_BYTES) {
      fail("Rendered visible text exceeds the per-page inspection limit");
    }
    return {
      path,
      status,
      visibleText,
      screenshotSha256s,
      screenshotBase64s,
      links: normalizeSameOriginRoutePaths(anchorHrefs, origin)
    };
  } catch (error) {
    return { path, status: null, error: errorMessage(error) };
  } finally {
    await baselineInstrumentation?.session
      .detach()
      .catch(() => undefined);
    await baselinePage?.context.close().catch(() => undefined);
  }
}

async function main() {
  const input = parseInput(process.argv[2] ?? "");
  const deadline = Date.now() + input.timeoutMilliseconds;
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium-browser",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run"
    ]
  });
  try {
    const queue = input.paths.map((path) => ({
      path,
      discovered: false
    }));
    const seen = new Set(input.paths);
    const results = [];
    let totalTextBytes = 0;
    let totalScreenshotBytes = 0;
    let totalScreenshotTiles = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue[index];
      const result = await inspectPath(browser, input, entry.path, deadline);
      const links = Array.isArray(result.links) ? result.links : [];
      for (const discoveredPath of links) {
        if (seen.has(discoveredPath)) {
          continue;
        }
        if (seen.size >= MAX_PATHS) {
          fail("Rendered-page route crawl exceeds the 32-route limit");
        }
        seen.add(discoveredPath);
        queue.push({ path: discoveredPath, discovered: true });
      }
      const publicResult = {
        path: result.path,
        discovered: entry.discovered,
        status: result.status,
        ...(typeof result.visibleText === "string"
          ? {
              visibleText: result.visibleText,
              screenshotSha256s: result.screenshotSha256s,
              screenshotBase64s: result.screenshotBase64s
            }
          : typeof result.nonHtmlMediaType === "string"
            ? { nonHtmlMediaType: result.nonHtmlMediaType }
            : { error: result.error })
      };
      if (typeof result.visibleText === "string") {
        totalTextBytes += Buffer.byteLength(result.visibleText, "utf8");
        if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
          results.push({
            path: entry.path,
            discovered: entry.discovered,
            status: null,
            error: "Rendered visible text exceeds the aggregate inspection limit"
          });
          continue;
        }
        for (const encoded of result.screenshotBase64s) {
          totalScreenshotBytes += Buffer.from(encoded, "base64").length;
          if (totalScreenshotBytes > MAX_SCREENSHOT_BYTES) {
            fail("Rendered screenshots exceed the aggregate byte limit");
          }
        }
        totalScreenshotTiles += result.screenshotBase64s.length;
        if (totalScreenshotTiles > MAX_TOTAL_SCREENSHOT_TILES) {
          fail("Rendered screenshots exceed the aggregate tile limit");
        }
      }
      results.push(publicResult);
    }
    let serialized = JSON.stringify({ version: 2, results });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_OUTPUT_BYTES) {
      serialized = JSON.stringify({
        version: 2,
        results: queue.map((entry) => ({
          path: entry.path,
          discovered: entry.discovered,
          status: null,
          error: "Rendered-page inspection output exceeded its bounded envelope"
        }))
      });
    }
    process.stdout.write(serialized + "\n");
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(errorMessage(error) + "\n");
  process.exitCode = 1;
});
`;
type DaytonaSandboxRole = "builder" | "verifier-commands" | "verifier-delivery";
const PROVEN_CONTAINER_IMAGE_TAG = "buildlabs-proof";
const MIN_FROZEN_PREVIEW_TTL_SECONDS = 60;
const MAX_FROZEN_PREVIEW_TTL_SECONDS = 7 * 24 * 60 * 60;
const FROZEN_PREVIEW_CLEANUP_GRACE_SECONDS = 5;
const FROZEN_PREVIEW_LIFECYCLE_BUFFER_MINUTES = 2;
const FROZEN_PREVIEW_PROBE_TIMEOUT_MILLISECONDS = 10_000;
const FROZEN_PREVIEW_PROBE_ATTEMPTS = 3;

export type DaytonaClientPort = Pick<
  Daytona,
  "create" | "get" | "list" | "snapshot"
> & {
  [Symbol.asyncDispose]?: () => Promise<void>;
};

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly #client: DaytonaClientPort;
  readonly #defaultSnapshot: string;
  #closePromise: Promise<void> | undefined;
  readonly #fetch: typeof fetch;
  readonly #frozenPreviewOperations = new Map<string, Promise<void>>();
  readonly #frozenPreviewCleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    config: AppConfig,
    client?: DaytonaClientPort,
    fetchImplementation: typeof fetch = globalThis.fetch,
  ) {
    this.#client =
      client ??
      new Daytona({
        apiKey: config.DAYTONA_API_KEY,
        apiUrl: config.DAYTONA_API_URL,
        ...(config.DAYTONA_TARGET ? { target: config.DAYTONA_TARGET } : {}),
        otelEnabled: config.DAYTONA_OTEL_ENABLED,
      });
    this.#defaultSnapshot = config.DAYTONA_BUILD_SNAPSHOT;
    this.#fetch = fetchImplementation;
  }

  async create(
    runId: string,
    assignment: BuildAssignment,
    signal?: AbortSignal,
  ): Promise<SandboxSession> {
    return initializeDaytonaSandboxWithDockerRetry(
      () => this.#createSandbox(runId, assignment, "builder", signal),
      async (sandbox) => {
        const workDir = await resolveSandboxWorkDir(sandbox, signal);
        const session = new DaytonaSandboxSession(
          sandbox,
          workDir,
          assignment.limits.maxToolOutputBytes,
          "builder",
        );
        await ensureDockerRuntime(sandbox, workDir, signal);
        await session.initializeRepository(signal);
        return session;
      },
      signal,
    );
  }

  async createVerifier(
    runId: string,
    assignment: BuildAssignment,
    revision: FrozenRevision,
    source: ExportedWorkspace,
    purpose: VerificationSandboxPurpose,
    signal?: AbortSignal,
  ): Promise<SandboxSession> {
    throwIfAborted(signal);
    await validateControllerExport(source);
    if (revision.sourceDigest !== source.contentDigest) {
      throw new Error(
        "Verification revision is not bound to the controller-held source",
      );
    }
    const role: DaytonaSandboxRole =
      purpose === "commands" ? "verifier-commands" : "verifier-delivery";
    return initializeDaytonaSandboxWithDockerRetry(
      () => this.#createSandbox(runId, assignment, role, signal),
      async (sandbox) => {
        const baseWorkDir = await resolveSandboxWorkDir(sandbox, signal);
        const verifierWorkDir = posix.join(
          baseWorkDir,
          `.buildlabs-verifier-${purpose}-${revision.sourceDigest.slice(0, 16)}`,
        );
        const session = new DaytonaSandboxSession(
          sandbox,
          verifierWorkDir,
          assignment.limits.maxToolOutputBytes,
          role,
        );
        await ensureDockerRuntime(sandbox, baseWorkDir, signal);
        const directory = await withAbort(
          sandbox.process.executeCommand(
            `mkdir -p -- ${shellQuote(verifierWorkDir)}`,
            baseWorkDir,
            {},
            30,
          ),
          signal,
        );
        if (directory.exitCode !== 0) {
          throw new Error("Could not create the Daytona verifier workspace");
        }
        await session.hydrateFromControllerExport(
          runId,
          purpose,
          revision,
          source,
          signal,
        );
        return session;
      },
      signal,
    );
  }

  async getPreview(
    sandboxId: string,
    port: number,
    expiresInSeconds: number,
    signal?: AbortSignal,
  ): Promise<PreviewTarget> {
    throwIfAborted(signal);
    const sandbox = await withAbort(this.#client.get(sandboxId), signal);
    const preview = await withAbort(
      sandbox.getSignedPreviewUrl(port, expiresInSeconds),
      signal,
    );
    return {
      url: preview.url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
    };
  }

  async deleteSandbox(sandboxId: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let sandbox: Sandbox;
    try {
      sandbox = await withAbort(this.#client.get(sandboxId), signal);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) {
        return;
      }
      throw error;
    }
    await withAbort(sandbox.delete(120, true), signal);
  }

  async materializeFrozenPreview(
    request: FrozenPreviewMaterializationRequest,
    signal?: AbortSignal,
  ): Promise<PreviewTarget> {
    validateFrozenPreviewMaterialization(request);
    const previous =
      this.#frozenPreviewOperations.get(request.eventId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => this.#materializeFrozenPreview(request, signal));
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#frozenPreviewOperations.set(request.eventId, settled);
    try {
      return await result;
    } finally {
      if (this.#frozenPreviewOperations.get(request.eventId) === settled) {
        this.#frozenPreviewOperations.delete(request.eventId);
      }
    }
  }

  async #materializeFrozenPreview(
    request: FrozenPreviewMaterializationRequest,
    signal?: AbortSignal,
  ): Promise<PreviewTarget> {
    throwIfAborted(signal);
    const sourceSnapshot = await withAbort(
      this.#client.snapshot.get(request.snapshotId),
      signal,
    );
    if (
      sourceSnapshot.name !== request.snapshotId ||
      sourceSnapshot.state !== "active"
    ) {
      throw new Error("The proven Daytona snapshot is not active");
    }

    const lifecycleMinutes =
      Math.ceil(request.expiresInSeconds / 60) +
      FROZEN_PREVIEW_LIFECYCLE_BUFFER_MINUTES;
    const identityLabels = frozenPreviewIdentityLabels(request);
    const effectLabels = frozenPreviewEffectLabels(request);
    const matches = await findFrozenPreviewSandboxes(
      this.#client,
      identityLabels,
      signal,
    );
    if (matches.length > 1) {
      throw new Error(
        "Multiple Daytona sandboxes claim the same proven preview identity",
      );
    }

    let previewSandbox = matches[0];
    if (!previewSandbox) {
      const sandboxName = frozenPreviewSandboxName(request.eventId);
      try {
        previewSandbox = await withAbort(
          this.#client.create(
            {
              name: sandboxName,
              snapshot: request.snapshotId,
              envVars: {
                BUILDLABS_RUN_ID: request.runId,
                BUILDLABS_PREVIEW_EVENT_ID: request.eventId,
                CI: "true",
              },
              labels: {
                ...identityLabels,
                ...effectLabels,
              },
              public: false,
              ephemeral: true,
              autoStopInterval: lifecycleMinutes,
              ttlMinutes: lifecycleMinutes,
            },
            { timeout: 120 },
          ),
          signal,
        );
      } catch (error) {
        throwIfAborted(signal);
        previewSandbox = await withAbort(
          this.#client.get(sandboxName),
          signal,
        ).catch(() => undefined);
        if (!previewSandbox) {
          throw error;
        }
      }
    }

    await withAbort(previewSandbox.refreshData(), signal);
    assertFrozenPreviewSandbox(
      previewSandbox,
      request.snapshotId,
      identityLabels,
    );
    const priorEffectKey = previewSandbox.labels["buildlabs.effect-key"];
    if (
      priorEffectKey === effectLabels["buildlabs.effect-key"] &&
      previewSandbox.labels["buildlabs.effect-input"] !==
        effectLabels["buildlabs.effect-input"]
    ) {
      throw new Error(
        "The frozen preview idempotency key was reused with different input",
      );
    }
    if (priorEffectKey !== effectLabels["buildlabs.effect-key"]) {
      await withAbort(
        previewSandbox.setLabels({
          ...previewSandbox.labels,
          ...identityLabels,
          ...effectLabels,
        }),
        signal,
      );
    }
    if (previewSandbox.state !== "started") {
      await withAbort(previewSandbox.start(120), signal);
    }
    await withAbort(previewSandbox.setTtl(lifecycleMinutes), signal);
    await withAbort(previewSandbox.refreshData(), signal);
    assertFrozenPreviewSandbox(
      previewSandbox,
      request.snapshotId,
      identityLabels,
    );

    const workDir =
      (await withAbort(previewSandbox.getWorkDir(), signal)) ?? ".";
    await ensureDockerRuntime(previewSandbox, workDir, signal);
    const session = new DaytonaSandboxSession(
      previewSandbox,
      workDir,
      MAX_COMMAND_ENVELOPE_BYTES,
      "verifier-delivery",
    );
    await session.sealNetworkForProof(signal);
    await session.startContainerPreview(
      PROVEN_CONTAINER_IMAGE_TAG,
      request.port,
      signal,
    );
    const preview = await session.getPreview(
      request.port,
      request.expiresInSeconds,
    );
    await verifyFrozenPreviewReadiness({
      fetchImplementation: this.#fetch,
      preview,
      expectedRevisionHash: request.revisionHash,
      expectedArtifactSha256: request.artifactSha256,
      signal,
    });
    throwIfAborted(signal);
    this.#scheduleFrozenPreviewCleanup(
      previewSandbox,
      request.expiresInSeconds + FROZEN_PREVIEW_CLEANUP_GRACE_SECONDS,
    );
    return preview;
  }

  #scheduleFrozenPreviewCleanup(
    sandbox: Sandbox,
    expiresInSeconds: number,
  ): void {
    const existing = this.#frozenPreviewCleanupTimers.get(sandbox.id);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.#frozenPreviewCleanupTimers.delete(sandbox.id);
      void sandbox.delete(120, true).catch(() => undefined);
    }, expiresInSeconds * 1_000);
    timer.unref();
    this.#frozenPreviewCleanupTimers.set(sandbox.id, timer);
  }

  async health(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const snapshot = await withAbort(
      this.#client.snapshot.get(this.#defaultSnapshot),
      signal,
    );
    if (
      snapshot.state !== "active" ||
      snapshot.cpu < 2 ||
      snapshot.mem < 4 ||
      snapshot.disk < 8
    ) {
      throw new Error(
        "The configured Daytona build snapshot is not active with at least 2 CPU, 4 GiB memory, and 8 GiB disk",
      );
    }
  }

  close(signal?: AbortSignal): Promise<void> {
    this.#closePromise ??= Promise.resolve().then(async () => {
      for (const timer of this.#frozenPreviewCleanupTimers.values()) {
        clearTimeout(timer);
      }
      this.#frozenPreviewCleanupTimers.clear();
      await this.#client[Symbol.asyncDispose]?.();
    });
    return withAbort(this.#closePromise, signal);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #createSandbox(
    runId: string,
    assignment: BuildAssignment,
    role: DaytonaSandboxRole,
    signal?: AbortSignal,
  ): Promise<Sandbox> {
    throwIfAborted(signal);
    const snapshot = assignment.sandbox.snapshot ?? this.#defaultSnapshot;
    if (snapshot !== this.#defaultSnapshot) {
      throw new Error(
        "The assignment requested a Daytona snapshot outside the configured build snapshot allowlist",
      );
    }
    const sandbox = await this.#client.create(
      {
        language: assignment.sandbox.language,
        ...(snapshot ? { snapshot } : {}),
        envVars: {
          BUILDLABS_RUN_ID: runId,
          BUILDLABS_SANDBOX_ROLE: role,
          CI: "true",
          DAYTONA_SANDBOX_OTEL_EXTRA_LABELS: daytonaTelemetryLabels(
            runId,
            assignment,
            role,
          ),
        },
        labels: {
          "buildlabs.run-id": runId,
          "buildlabs.project-id": assignment.projectId,
          "buildlabs.candidate-id": assignment.candidateId,
          "buildlabs.role": role,
        },
        public: false,
        autoStopInterval: assignment.sandbox.autoStopMinutes,
        autoArchiveInterval: assignment.sandbox.autoArchiveMinutes,
        ttlMinutes: Math.max(
          assignment.sandbox.autoArchiveMinutes,
          Math.ceil(assignment.limits.wallClockSeconds / 60) + 30,
        ),
      },
      { timeout: 120 },
    );
    if (signal?.aborted) {
      await sandbox.delete(120, true).catch(() => undefined);
      throwIfAborted(signal);
    }
    return sandbox;
  }
}

export function daytonaTelemetryLabels(
  runId: string,
  assignment: Pick<BuildAssignment, "projectId" | "candidateId">,
  role: DaytonaSandboxRole = "builder",
): string {
  const labels: Array<readonly [string, string]> = [
    ["buildlabs_run_id", runId],
    ["buildlabs_project_id", assignment.projectId],
    ["buildlabs_candidate_id", assignment.candidateId],
    ["buildlabs_sandbox_role", role],
  ];
  return labels
    .map(([key, value]) => `${key}=${daytonaTelemetryLabelValue(value)}`)
    .join(",");
}

function daytonaTelemetryLabelValue(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Daytona telemetry label value is invalid");
  }
  return value;
}

class FrozenPreviewIdentityError extends Error {
  override readonly name = "FrozenPreviewIdentityError";
}

async function verifyFrozenPreviewReadiness(input: {
  fetchImplementation: typeof fetch;
  preview: PreviewTarget;
  expectedRevisionHash: string;
  expectedArtifactSha256: string;
  signal: AbortSignal | undefined;
}): Promise<void> {
  let previewUrl: URL;
  try {
    previewUrl = new URL(input.preview.url);
  } catch {
    throw new Error("Frozen preview URL is invalid");
  }
  if (
    previewUrl.protocol !== "https:" ||
    previewUrl.username.length > 0 ||
    previewUrl.password.length > 0
  ) {
    throw new Error(
      "Frozen preview readiness probe requires credential-free HTTPS",
    );
  }

  const deadline = Date.now() + FROZEN_PREVIEW_PROBE_TIMEOUT_MILLISECONDS;
  let lastError: Error | undefined;
  for (
    let attempt = 0;
    attempt < FROZEN_PREVIEW_PROBE_ATTEMPTS && Date.now() < deadline;
    attempt += 1
  ) {
    throwIfAborted(input.signal);
    const timeoutSignal = AbortSignal.timeout(
      Math.max(1, deadline - Date.now()),
    );
    const combinedSignal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    try {
      const response = await input.fetchImplementation(input.preview.url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "X-Daytona-Skip-Preview-Warning": "true",
        },
        signal: combinedSignal,
      });
      const revisionMarker = response.headers.get("x-buildlabs-revision");
      const artifactMarker = response.headers.get(
        "x-buildlabs-artifact-sha256",
      );
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) {
        /*
         * Existing generated images do not yet guarantee identity headers, so
         * marker absence proves HTTPS reachability only. Once either marker is
         * present, both must exactly match the frozen proof identity.
         */
        if (
          (revisionMarker !== null || artifactMarker !== null) &&
          (revisionMarker !== input.expectedRevisionHash ||
            artifactMarker !== input.expectedArtifactSha256)
        ) {
          throw new FrozenPreviewIdentityError(
            "Frozen preview identity markers do not match the proven artifact",
          );
        }
        return;
      }
      lastError = new Error(
        `Frozen preview readiness probe returned HTTP ${response.status}`,
      );
    } catch (error) {
      if (error instanceof FrozenPreviewIdentityError) {
        throw error;
      }
      lastError =
        error instanceof Error
          ? error
          : new Error("Frozen preview readiness probe failed");
    }
    if (attempt + 1 < FROZEN_PREVIEW_PROBE_ATTEMPTS && Date.now() < deadline) {
      await abortableDelay(100 * (attempt + 1), input.signal);
    }
  }
  throw (
    lastError ??
    new Error("Frozen preview did not become ready before the probe deadline")
  );
}

function validateFrozenPreviewMaterialization(
  request: FrozenPreviewMaterializationRequest,
): void {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const sha256Pattern = /^[0-9a-f]{64}$/;
  if (
    !/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/.test(request.snapshotId) ||
    !uuid.test(request.runId) ||
    !uuid.test(request.eventId) ||
    !uuid.test(request.artifactId) ||
    !sha256Pattern.test(request.artifactSha256) ||
    !sha256Pattern.test(request.revisionHash) ||
    !Number.isInteger(request.port) ||
    request.port < 1 ||
    request.port > 65_535 ||
    !Number.isInteger(request.expiresInSeconds) ||
    request.expiresInSeconds < MIN_FROZEN_PREVIEW_TTL_SECONDS ||
    request.expiresInSeconds > MAX_FROZEN_PREVIEW_TTL_SECONDS ||
    !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/.test(request.idempotencyKey)
  ) {
    throw new Error("Frozen preview materialization request is invalid");
  }
}

function frozenPreviewIdentityLabels(
  request: FrozenPreviewMaterializationRequest,
): Record<string, string> {
  return {
    "buildlabs.purpose": "proven-preview",
    "buildlabs.run-id": request.runId,
    "buildlabs.event-id": request.eventId,
    "buildlabs.artifact-id": request.artifactId,
    "buildlabs.revision": request.revisionHash.slice(0, 32),
  };
}

function frozenPreviewSandboxName(eventId: string): string {
  return `buildlabs-preview-${eventId}`;
}

function frozenPreviewEffectLabels(
  request: FrozenPreviewMaterializationRequest,
): Record<string, string> {
  return {
    "buildlabs.effect-key": sha256(request.idempotencyKey).slice(0, 32),
    "buildlabs.effect-input": sha256(
      JSON.stringify({
        artifactId: request.artifactId,
        artifactSha256: request.artifactSha256,
        eventId: request.eventId,
        expiresInSeconds: request.expiresInSeconds,
        port: request.port,
        revisionHash: request.revisionHash,
        runId: request.runId,
        snapshotId: request.snapshotId,
      }),
    ).slice(0, 32),
  };
}

async function findFrozenPreviewSandboxes(
  client: DaytonaClientPort,
  identityLabels: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<Sandbox[]> {
  const iterator = client.list({
    labels: { ...identityLabels },
    limit: 2,
  });
  const matches: Sandbox[] = [];
  try {
    while (matches.length < 2) {
      const next = await withAbort(iterator.next(), signal);
      if (next.done) {
        break;
      }
      matches.push(next.value);
    }
    return matches;
  } finally {
    void iterator.return?.().catch(() => undefined);
  }
}

function assertFrozenPreviewSandbox(
  sandbox: Sandbox,
  snapshotId: string,
  identityLabels: Readonly<Record<string, string>>,
): void {
  if (
    sandbox.snapshot !== snapshotId ||
    sandbox.public ||
    Object.entries(identityLabels).some(
      ([key, value]) => sandbox.labels[key] !== value,
    )
  ) {
    throw new Error(
      "The isolated preview sandbox did not retain the proven snapshot boundary",
    );
  }
}

export class DaytonaSandboxSession implements SandboxSession {
  readonly id: string;
  readonly workDir: string;
  #lastFrozen?: FrozenRevision;
  #workspaceCommitSha?: string;
  #controllerContentDigest?: string;
  #proofNetworkSealed = false;

  constructor(
    private readonly sandbox: Sandbox,
    workDir: string,
    private readonly maxCommandEnvelopeBytes: number,
    private readonly role: DaytonaSandboxRole,
  ) {
    this.id = sandbox.id;
    this.workDir = workDir;
  }

  async initializeRepository(signal?: AbortSignal): Promise<void> {
    const excludeFile = GIT_EXCLUDES.join("\n");
    const command = [
      "git init -q",
      "git branch -M main",
      "git config user.name 'BuildLabs Controller'",
      "git config user.email 'controller@buildlabs.invalid'",
      "mkdir -p .git/info .buildlabs",
      `printf '%s\\n' ${shellQuote(excludeFile)} > .git/info/exclude`,
      "git commit --allow-empty -q -m 'BuildLabs baseline'",
    ].join(" && ");
    const result = await this.runCommand(command, 30, signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to initialize candidate repository: ${result.stdout}`,
      );
    }
  }

  async runCommand(
    command: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return executeBoundedSandboxCommand(
      this.sandbox.process,
      command,
      this.workDir,
      timeoutSeconds,
      this.maxCommandEnvelopeBytes,
      signal,
    );
  }

  async readFile(path: string): Promise<string> {
    return (await this.sandbox.fs.downloadFile(path)).toString("utf8");
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const parent = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : ".";
    if (parent !== ".") {
      const mkdirResult = await this.runCommand(
        `mkdir -p -- ${shellQuote(parent)}`,
        30,
      );
      if (mkdirResult.exitCode !== 0) {
        throw new Error(`Could not create parent directory for ${path}`);
      }
    }
    await this.sandbox.fs.uploadFile(Buffer.from(contents, "utf8"), path);
  }

  async listFiles(path: string, depth: number): Promise<SandboxFile[]> {
    const files = await this.sandbox.fs.listFiles(path, { depth });
    return files.map((file) => {
      const rawPath = file.path ?? file.name;
      const normalized = relativeWorkspacePath(this.workDir, rawPath);
      return {
        path: normalized,
        name: file.name,
        size: file.size,
        isDirectory: file.isDir,
      };
    });
  }

  async startPreview(
    command: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.role !== "builder") {
      throw new Error(
        "Live preview is restricted to the Daytona builder sandbox",
      );
    }
    const scriptPath = ".buildlabs/start-preview.sh";
    const script = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export PORT=${port}`,
      command,
      "",
    ].join("\n");
    await this.sandbox.fs.uploadFile(Buffer.from(script, "utf8"), scriptPath);
    const sessionId = "buildlabs-preview";
    await deleteDaytonaSessionIfPresent(
      this.sandbox.process,
      sessionId,
      signal,
    );
    await withAbort(this.sandbox.process.createSession(sessionId), signal);
    const result = await withAbort(
      this.sandbox.process.executeSessionCommand(
        sessionId,
        {
          command: `bash ${scriptPath}`,
          runAsync: true,
          suppressInputEcho: true,
        },
        30,
      ),
      signal,
    );
    if (!result.cmdId) {
      throw new Error("Failed to start the Daytona live preview session");
    }
    const ready = await this.runCommand(
      [
        "for attempt in $(seq 1 90); do",
        `  if curl --silent --show-error --output /dev/null --max-time 2 http://127.0.0.1:${port}/; then exit 0; fi`,
        "  sleep 1",
        "done",
        "exit 1",
      ].join("\n"),
      100,
      signal,
    );
    if (ready.exitCode !== 0) {
      throw new Error(
        `Daytona live preview did not respond on port ${port} within 90 seconds`,
      );
    }
  }

  async sealNetworkForProof(signal?: AbortSignal): Promise<void> {
    if (this.role !== "verifier-delivery") {
      throw new Error(
        "Network sealing is restricted to the Daytona delivery verifier",
      );
    }
    await this.#applyProofNetworkSeal(signal);
  }

  async #applyProofNetworkSeal(signal?: AbortSignal): Promise<void> {
    this.#proofNetworkSealed = false;
    throwIfAborted(signal);
    await withAbort(
      this.sandbox.updateNetworkSettings({ networkBlockAll: true }),
      signal,
    );
    throwIfAborted(signal);
    this.#proofNetworkSealed = true;
  }

  async startContainerPreview(
    imageTag: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.role !== "verifier-delivery" || !this.#proofNetworkSealed) {
      throw new Error(
        "Container proof requires a network-sealed Daytona delivery verifier",
      );
    }
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(imageTag)) {
      throw new Error("Container image tag is invalid");
    }
    await deleteDaytonaSessionIfPresent(
      this.sandbox.process,
      "buildlabs-preview",
      signal,
    );
    const command = deliveryContainerRunCommand(imageTag, port);
    const result = await this.runCommand(command, 120, signal);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to start proven container preview: ${result.stderr || result.stdout}`,
      );
    }
    const ready = await this.runCommand(
      [
        "for attempt in $(seq 1 90); do",
        `  if curl --silent --show-error --output /dev/null --max-time 2 http://127.0.0.1:${port}/; then exit 0; fi`,
        "  sleep 1",
        "done",
        "exit 1",
      ].join("\n"),
      100,
      signal,
    );
    if (ready.exitCode !== 0) {
      throw new Error(
        `Proven container preview did not respond on port ${port} within 90 seconds`,
      );
    }
  }

  async inspectRenderedPages(
    paths: string[],
    port: number,
    timeoutMilliseconds: number,
    signal?: AbortSignal,
  ): Promise<RenderedPageInspection[]> {
    if (this.role !== "verifier-delivery") {
      throw new Error(
        "Rendered-page proof is restricted to the Daytona delivery verifier",
      );
    }
    if (!this.#proofNetworkSealed) {
      throw new Error(
        "Rendered-page proof requires a network-sealed Daytona delivery verifier",
      );
    }
    return inspectRenderedPagesInDaytonaSandbox(
      this.sandbox,
      this.workDir,
      paths,
      port,
      timeoutMilliseconds,
      signal,
    );
  }

  async freeze(): Promise<FrozenRevision> {
    const commit = await this.runCommand(
      [
        "git add -A",
        "git commit --allow-empty -q -m 'BuildLabs frozen candidate'",
        "git rev-parse HEAD",
      ].join(" && "),
      120,
    );
    if (commit.exitCode !== 0) {
      throw new Error(`Could not freeze candidate revision: ${commit.stdout}`);
    }
    const commitSha = commit.stdout.trim().split(/\s+/).at(-1);
    if (!commitSha || !/^[a-f0-9]{40,64}$/i.test(commitSha)) {
      throw new Error("Candidate repository returned an invalid commit id");
    }
    const revision: FrozenRevision = {
      sourceDigest: sha256(`git-commit:${commitSha}`),
      commitSha,
      frozenAt: new Date().toISOString(),
    };
    this.#lastFrozen = revision;
    this.#workspaceCommitSha = commitSha;
    return revision;
  }

  async currentRevisionDigest(): Promise<string> {
    if (!this.#lastFrozen) {
      return sha256("unfrozen");
    }
    const head = await this.runCommand("git rev-parse HEAD", 30);
    const refresh = await this.runCommand(
      "git update-index --really-refresh",
      30,
    );
    const status = await this.runCommand(
      "git status --porcelain=v1 --untracked-files=all",
      30,
    );
    if (head.exitCode !== 0 || status.exitCode !== 0) {
      throw new Error(`Could not inspect candidate revision: ${status.stdout}`);
    }
    const currentHead = head.stdout.trim().split(/\s+/).at(-1);
    return currentHead === this.#workspaceCommitSha &&
      refresh.exitCode === 0 &&
      status.stdout.trim().length === 0
      ? this.#lastFrozen.sourceDigest
      : sha256(
          `changed:${currentHead ?? "missing"}:${refresh.exitCode}:${status.stdout}`,
        );
  }

  async hydrateFromControllerExport(
    runId: string,
    purpose: VerificationSandboxPurpose,
    revision: FrozenRevision,
    source: ExportedWorkspace,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const remoteArchive = `/tmp/buildlabs-source-${runId}-${purpose}-${revision.sourceDigest.slice(0, 16)}.tar`;
    await withAbort(
      this.sandbox.fs.uploadFile(source.archivePath, remoteArchive, 300),
      signal,
    );
    const excludeFile = GIT_EXCLUDES.join("\n");
    const hydrate = await this.runCommand(
      [
        `test "$(sha256sum ${shellQuote(remoteArchive)} | cut -d ' ' -f 1)" = ${shellQuote(source.archiveSha256)}`,
        `tar -xf ${shellQuote(remoteArchive)} -C .`,
        `rm -f -- ${shellQuote(remoteArchive)}`,
        "git init -q",
        "git branch -M main",
        "git config user.name 'BuildLabs Controller'",
        "git config user.email 'controller@buildlabs.invalid'",
        "git add -f -A",
        "git commit --allow-empty -q -m 'BuildLabs verified source'",
        "git rev-parse HEAD",
        "mkdir -p .git/info .buildlabs",
        `printf '%s\\n' ${shellQuote(excludeFile)} > .git/info/exclude`,
      ].join(" && "),
      300,
      signal,
    );
    if (hydrate.exitCode !== 0) {
      throw new Error(
        `Could not hydrate the Daytona verifier from the attested source export: ${hydrate.stderr || hydrate.stdout}`,
      );
    }
    const commitSha = hydrate.stdout.trim().split(/\s+/).at(-1);
    if (!commitSha || !/^[a-f0-9]{40,64}$/i.test(commitSha)) {
      throw new Error("Daytona verifier returned an invalid source commit id");
    }
    this.#lastFrozen = { ...revision };
    this.#workspaceCommitSha = commitSha;
    this.#controllerContentDigest = source.contentDigest;
    if ((await this.currentRevisionDigest()) !== revision.sourceDigest) {
      throw new Error(
        "Daytona verifier source does not match the attested frozen revision",
      );
    }
  }

  async createSnapshot(name: string, signal?: AbortSignal): Promise<string> {
    if (this.role !== "verifier-delivery" || !this.#proofNetworkSealed) {
      throw new Error(
        "Snapshot promotion requires a network-sealed Daytona delivery verifier",
      );
    }
    if (!/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/.test(name)) {
      throw new Error("Daytona snapshot name is invalid");
    }
    throwIfAborted(signal);
    await this.sandbox.stop(120);
    try {
      await this.sandbox._experimental_createSnapshot(name, 300);
    } finally {
      await this.sandbox.start(120);
      await this.#applyProofNetworkSeal(signal);
      await ensureDockerRuntime(this.sandbox, this.workDir, signal);
    }
    throwIfAborted(signal);
    return name;
  }

  async exportWorkspace(revision: FrozenRevision): Promise<ExportedWorkspace> {
    if (
      !this.#lastFrozen ||
      !this.#workspaceCommitSha ||
      this.#lastFrozen.sourceDigest !== revision.sourceDigest ||
      this.#lastFrozen.commitSha !== revision.commitSha ||
      this.#lastFrozen.frozenAt !== revision.frozenAt ||
      (await this.currentRevisionDigest()) !== revision.sourceDigest
    ) {
      throw new Error("Candidate source changed after its revision was frozen");
    }

    const localDirectory = await mkdtemp(
      join(tmpdir(), "buildlabs-candidate-"),
    );
    const localArchive = join(localDirectory, "workspace.tar");
    const extractionDirectory = join(localDirectory, "workspace");
    const remoteExportDirectory = posix.join(this.workDir, ".buildlabs");
    const remoteArchive = posix.join(
      remoteExportDirectory,
      `export-${revision.sourceDigest}.tar`,
    );
    const remoteManifest = posix.join(
      remoteExportDirectory,
      `export-${revision.sourceDigest}.files`,
    );
    const localManifest = join(localDirectory, "workspace.files");
    let exportedWorkspace: ExportedWorkspace | undefined;
    let exportFailure: unknown;
    let exportFailed = false;
    try {
      const manifest = await this.runCommand(
        `git ls-tree -r -z --full-tree ${shellQuote(this.#workspaceCommitSha)} > ${shellQuote(remoteManifest)}`,
        60,
      );
      if (manifest.exitCode !== 0) {
        throw new Error(
          `Could not enumerate frozen candidate workspace: ${manifest.stdout}`,
        );
      }
      const archive = await this.runCommand(
        `git archive --format=tar --output=${shellQuote(remoteArchive)} ${shellQuote(this.#workspaceCommitSha)}`,
        300,
      );
      if (archive.exitCode !== 0) {
        throw new Error(
          `Could not export candidate workspace: ${archive.stdout}`,
        );
      }
      await this.sandbox.fs.downloadFile(remoteManifest, localManifest, 60);
      await this.sandbox.fs.downloadFile(remoteArchive, localArchive, 300);
      const archiveStat = await stat(localArchive);
      if (
        !archiveStat.isFile() ||
        archiveStat.size === 0 ||
        archiveStat.size > MAX_ARCHIVE_BYTES
      ) {
        throw new Error("Candidate archive size is outside allowed limits");
      }
      const expectedPaths = parseGitTreeManifest(await readFile(localManifest));
      await validateSourceArchive(localArchive, expectedPaths);
      await mkdir(extractionDirectory, { recursive: true, mode: 0o700 });
      await tar.x({
        cwd: extractionDirectory,
        file: localArchive,
        preservePaths: false,
        unlink: true,
      });
      const archiveSha256 = await sha256File(localArchive);
      const contentDigest = await sourceTreeDigest(extractionDirectory);
      if (
        this.#controllerContentDigest &&
        contentDigest !== this.#controllerContentDigest
      ) {
        throw new Error(
          "Exported verifier source does not match the controller-bound revision",
        );
      }
      exportedWorkspace = {
        directory: extractionDirectory,
        archivePath: localArchive,
        archiveSha256,
        contentDigest,
        cleanup: async () => {
          await rm(localDirectory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      exportFailed = true;
      exportFailure = error;
    }

    let cleanupFailure: unknown;
    let cleanupFailed = false;
    try {
      const cleanup = await this.runCommand(
        `rm -f -- ${shellQuote(remoteManifest)} ${shellQuote(remoteArchive)}`,
        60,
      );
      if (cleanup.exitCode !== 0) {
        throw new Error("Could not remove remote candidate export files");
      }
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
    }

    if (exportFailed || cleanupFailed || !exportedWorkspace) {
      await rm(localDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (exportFailed) {
        throw exportFailure;
      }
      if (cleanupFailed) {
        throw cleanupFailure;
      }
      throw new Error("Candidate workspace export did not produce an artifact");
    }
    return exportedWorkspace;
  }

  async getPreview(
    port: number,
    expiresInSeconds: number,
  ): Promise<PreviewTarget> {
    const preview = await this.sandbox.getSignedPreviewUrl(
      port,
      expiresInSeconds,
    );
    return {
      url: preview.url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
    };
  }

  async stop(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.sandbox.stop(120);
    throwIfAborted(signal);
  }

  async dispose(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.sandbox.delete(120, true);
    throwIfAborted(signal);
  }
}

export function deliveryContainerRunCommand(
  imageTag: string,
  port: number,
): string {
  return [
    "docker rm -f buildlabs-proof >/dev/null 2>&1 || true",
    `docker run -d --name buildlabs-proof --pull never -p 127.0.0.1:${port}:${port} -e PORT=${port} ${shellQuote(imageTag)}`,
  ].join(" && ");
}

export async function inspectRenderedPagesInDaytonaSandbox(
  sandbox: Pick<Sandbox, "fs" | "process">,
  workDir: string,
  paths: string[],
  port: number,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<RenderedPageInspection[]> {
  if (
    paths.length < 1 ||
    paths.length > MAX_RENDER_PATHS ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !isCanonicalRenderedRoutePath(path))
  ) {
    throw new Error("Rendered preview paths are invalid");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Rendered preview port is invalid");
  }
  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > MAX_RENDER_TOTAL_TIMEOUT_MILLISECONDS
  ) {
    throw new Error("Rendered preview timeout is invalid");
  }

  throwIfAborted(signal);
  await withAbort(
    sandbox.fs.uploadFile(
      Buffer.from(RENDERED_PAGE_INSPECTOR_SOURCE, "utf8"),
      RENDER_INSPECTOR_PATH,
    ),
    signal,
  );
  const encodedInput = Buffer.from(
    JSON.stringify({ paths, port, timeoutMilliseconds }),
    "utf8",
  ).toString("base64url");
  const commandTimeoutSeconds = Math.ceil(timeoutMilliseconds / 1_000) + 15;
  const command = [
    "set -euo pipefail",
    'browser_tmp=$(mktemp -d "${TMPDIR:-/tmp}/buildlabs-browser.XXXXXX")',
    "cleanup() {",
    '  pkill -KILL -f -- "$browser_tmp" >/dev/null 2>&1 || true',
    '  rm -rf -- "$browser_tmp"',
    "}",
    "trap cleanup EXIT",
    `chmod 500 -- ${shellQuote(RENDER_INSPECTOR_PATH)}`,
    `NODE_PATH=${shellQuote(PLAYWRIGHT_NODE_PATH)} TMPDIR="$browser_tmp" timeout -k 5s ${commandTimeoutSeconds}s node ${shellQuote(RENDER_INSPECTOR_PATH)} ${shellQuote(encodedInput)}`,
  ].join("\n");
  const result = await executeBoundedSandboxCommand(
    sandbox.process,
    command,
    workDir,
    commandTimeoutSeconds + 10,
    RENDER_COMMAND_ENVELOPE_BYTES,
    signal,
    RENDER_COMMAND_ENVELOPE_BYTES,
  );
  if (
    result.exitCode !== 0 ||
    result.stdoutTruncated ||
    result.stderrTruncated
  ) {
    const diagnostic = (result.stderr || result.stdout)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2_000);
    throw new Error(
      `Daytona rendered-page inspector failed${diagnostic ? `: ${diagnostic}` : ""}`,
    );
  }
  return parseRenderedPageInspectionOutput(result.stdout, paths);
}

export function parseRenderedPageInspectionOutput(
  stdout: string,
  expectedPaths: string[],
): RenderedPageInspection[] {
  if (
    expectedPaths.length < 1 ||
    expectedPaths.length > MAX_RENDER_PATHS ||
    new Set(expectedPaths).size !== expectedPaths.length ||
    expectedPaths.some((path) => !isCanonicalRenderedRoutePath(path))
  ) {
    throw new Error("Expected rendered-page paths are invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Daytona rendered-page inspector returned invalid JSON");
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 2 ||
    !Array.isArray(parsed.results) ||
    parsed.results.length < expectedPaths.length ||
    parsed.results.length > MAX_RENDER_PATHS
  ) {
    throw new Error("Daytona rendered-page inspector returned invalid output");
  }

  const seen = new Set<string>();
  let totalVisibleTextBytes = 0;
  let totalScreenshotBytes = 0;
  let totalScreenshotTiles = 0;
  return parsed.results.map<RenderedPageInspection>((value, index) => {
    const expectedPath = expectedPaths[index];
    const expectedDiscovered = expectedPath === undefined;
    if (
      !isRecord(value) ||
      typeof value.path !== "string" ||
      value.discovered !== expectedDiscovered ||
      (expectedPath !== undefined
        ? value.path !== expectedPath
        : !isCanonicalRenderedRoutePath(value.path) ||
          expectedPaths.includes(value.path)) ||
      seen.has(value.path)
    ) {
      throw new Error(
        "Daytona rendered-page inspector returned an unexpected path",
      );
    }
    const path = value.path;
    seen.add(path);
    const status = value.status;
    const visibleText = value.visibleText;
    const screenshotSha256s = value.screenshotSha256s;
    const screenshotBase64s = value.screenshotBase64s;
    const nonHtmlMediaType = value.nonHtmlMediaType;
    const error = value.error;
    if (status === null) {
      if (
        typeof error !== "string" ||
        error.length < 1 ||
        error.length > 4_096 ||
        visibleText !== undefined ||
        screenshotSha256s !== undefined ||
        screenshotBase64s !== undefined ||
        nonHtmlMediaType !== undefined
      ) {
        throw new Error(
          "Daytona rendered-page inspector returned an invalid error result",
        );
      }
      return {
        path,
        ...(expectedDiscovered ? { discovered: true as const } : {}),
        status: null,
        error,
      };
    }
    if (nonHtmlMediaType !== undefined) {
      if (
        !Number.isInteger(status) ||
        Number(status) < 100 ||
        Number(status) > 599 ||
        typeof nonHtmlMediaType !== "string" ||
        nonHtmlMediaType.length < 1 ||
        nonHtmlMediaType.length > 200 ||
        visibleText !== undefined ||
        screenshotSha256s !== undefined ||
        screenshotBase64s !== undefined ||
        error !== undefined
      ) {
        throw new Error(
          "Daytona rendered-page inspector returned an invalid non-HTML result",
        );
      }
      return {
        path,
        ...(expectedDiscovered ? { discovered: true as const } : {}),
        status: Number(status),
        nonHtmlMediaType,
      };
    }
    if (
      !Number.isInteger(status) ||
      Number(status) < 100 ||
      Number(status) > 599 ||
      typeof visibleText !== "string" ||
      Buffer.byteLength(visibleText, "utf8") > MAX_RENDERED_TEXT_BYTES ||
      !Array.isArray(screenshotSha256s) ||
      screenshotSha256s.length < 1 ||
      screenshotSha256s.length > MAX_RENDER_SCREENSHOT_TILES ||
      !Array.isArray(screenshotBase64s) ||
      screenshotBase64s.length !== screenshotSha256s.length ||
      screenshotSha256s.some(
        (digest) =>
          typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest),
      ) ||
      error !== undefined
    ) {
      throw new Error(
        "Daytona rendered-page inspector returned an invalid success result",
      );
    }
    for (const [screenshotIndex, encoded] of screenshotBase64s.entries()) {
      const bytes = decodeCanonicalBase64(encoded);
      if (
        !bytes ||
        bytes.length < 8 ||
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        sha256(bytes) !== screenshotSha256s[screenshotIndex]
      ) {
        throw new Error(
          "Daytona rendered-page inspector returned invalid screenshot bytes",
        );
      }
      totalScreenshotBytes += bytes.length;
      if (totalScreenshotBytes > MAX_RENDER_SCREENSHOT_BYTES) {
        throw new Error(
          "Daytona rendered-page inspector returned excessive screenshot bytes",
        );
      }
    }
    totalScreenshotTiles += screenshotBase64s.length;
    if (totalScreenshotTiles > MAX_RENDER_TOTAL_SCREENSHOT_TILES) {
      throw new Error(
        "Daytona rendered-page inspector returned excessive screenshot tiles",
      );
    }
    totalVisibleTextBytes += Buffer.byteLength(visibleText, "utf8");
    if (totalVisibleTextBytes > 300_000) {
      throw new Error(
        "Daytona rendered-page inspector returned excessive aggregate text",
      );
    }
    return {
      path,
      ...(expectedDiscovered ? { discovered: true as const } : {}),
      status: Number(status),
      visibleText,
      screenshotSha256s: screenshotSha256s.map(String),
      screenshotBase64s: screenshotBase64s.map(String),
    };
  });
}

function decodeCanonicalBase64(value: unknown): Buffer | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function executeBoundedSandboxCommand(
  process: Pick<Sandbox["process"], "executeCommand">,
  command: string,
  workDir: string,
  timeoutSeconds: number,
  requestedEnvelopeBytes: number,
  signal?: AbortSignal,
  maximumEnvelopeBytes = MAX_COMMAND_ENVELOPE_BYTES,
): Promise<CommandResult> {
  throwIfAborted(signal);
  if (
    !Number.isSafeInteger(requestedEnvelopeBytes) ||
    requestedEnvelopeBytes < 1_024 ||
    !Number.isSafeInteger(maximumEnvelopeBytes) ||
    maximumEnvelopeBytes < 1_024
  ) {
    throw new Error("Daytona command output limit is invalid");
  }
  const envelopeBytes = Math.min(requestedEnvelopeBytes, maximumEnvelopeBytes);
  const rawOutputBudget =
    Math.floor(((envelopeBytes - COMMAND_ENVELOPE_OVERHEAD_BYTES) * 3) / 4) - 8;
  if (rawOutputBudget < 1) {
    throw new Error("Daytona command output limit is too small");
  }
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  const wrapper = [
    "set +e",
    "umask 077",
    'capture_dir=$(mktemp -d "${TMPDIR:-/tmp}/buildlabs-command.XXXXXX") || exit 125',
    'cleanup() { rm -rf -- "$capture_dir"; }',
    "trap cleanup EXIT",
    'stdout_file="$capture_dir/stdout"',
    'stderr_file="$capture_dir/stderr"',
    'command_file="$capture_dir/command.sh"',
    `printf '%s' ${shellQuote(encodedCommand)} | base64 -d > "$command_file" || exit 125`,
    'chmod 700 "$command_file" || exit 125',
    ': > "$stdout_file"',
    ': > "$stderr_file"',
    'bash "$command_file" > "$stdout_file" 2> "$stderr_file"',
    "command_exit=$?",
    'stdout_size=$(wc -c < "$stdout_file" | tr -d "[:space:]")',
    'stderr_size=$(wc -c < "$stderr_file" | tr -d "[:space:]")',
    `raw_budget=${rawOutputBudget}`,
    "half_budget=$((raw_budget / 2))",
    "stdout_take=$half_budget",
    'if [ "$stdout_size" -lt "$stdout_take" ]; then stdout_take=$stdout_size; fi',
    "remaining=$((raw_budget - stdout_take))",
    "stderr_take=$remaining",
    'if [ "$stderr_size" -lt "$stderr_take" ]; then stderr_take=$stderr_size; fi',
    "remaining=$((raw_budget - stdout_take - stderr_take))",
    'if [ "$remaining" -gt 0 ] && [ "$stdout_size" -gt "$stdout_take" ]; then',
    "  stdout_extra=$((stdout_size - stdout_take))",
    '  if [ "$stdout_extra" -gt "$remaining" ]; then stdout_extra=$remaining; fi',
    "  stdout_take=$((stdout_take + stdout_extra))",
    "fi",
    `printf '%s\\n' ${shellQuote(COMMAND_ENVELOPE_MAGIC)} "$command_exit" "$stdout_size" "$stderr_size" "$stdout_take" "$stderr_take"`,
    'if [ "$stdout_take" -gt 0 ]; then',
    '  head -c "$stdout_take" "$stdout_file" | base64 | tr -d "\\n"',
    "fi",
    "printf '\\n'",
    'if [ "$stderr_take" -gt 0 ]; then',
    '  head -c "$stderr_take" "$stderr_file" | base64 | tr -d "\\n"',
    "fi",
    "printf '\\n'",
    "exit 0",
  ].join("\n");

  const started = performance.now();
  const response = await withAbort(
    process.executeCommand(wrapper, workDir, {}, timeoutSeconds),
    signal,
  );
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  if (response.exitCode !== 0) {
    throw new Error("Daytona command output wrapper did not complete");
  }
  const envelope = response.result ?? response.artifacts?.stdout ?? "";
  if (Buffer.byteLength(envelope, "utf8") > envelopeBytes) {
    throw new Error("Daytona command output envelope exceeded its hard limit");
  }
  return parseCommandEnvelope(envelope, rawOutputBudget, durationMs);
}

function parseCommandEnvelope(
  envelope: string,
  rawOutputBudget: number,
  durationMs: number,
): CommandResult {
  const lines = envelope.split("\n");
  if (
    lines.length !== 9 ||
    lines[0] !== COMMAND_ENVELOPE_MAGIC ||
    lines[8] !== ""
  ) {
    throw new Error("Daytona command returned a malformed output envelope");
  }
  const exitCode = parseEnvelopeInteger(lines[1], "exit code");
  const stdoutSize = parseEnvelopeInteger(lines[2], "stdout size");
  const stderrSize = parseEnvelopeInteger(lines[3], "stderr size");
  const stdoutTake = parseEnvelopeInteger(lines[4], "stdout capture size");
  const stderrTake = parseEnvelopeInteger(lines[5], "stderr capture size");
  if (
    exitCode > 255 ||
    stdoutTake > stdoutSize ||
    stderrTake > stderrSize ||
    stdoutTake + stderrTake > rawOutputBudget
  ) {
    throw new Error("Daytona command output envelope is inconsistent");
  }
  return {
    exitCode,
    stdout: decodeEnvelopeOutput(lines[6], stdoutTake),
    stderr: decodeEnvelopeOutput(lines[7], stderrTake),
    stdoutTruncated: stdoutTake < stdoutSize,
    stderrTruncated: stderrTake < stderrSize,
    durationMs,
  };
}

function parseEnvelopeInteger(
  value: string | undefined,
  field: string,
): number {
  if (!value || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new Error(`Daytona command output envelope has an invalid ${field}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Daytona command output envelope has an invalid ${field}`);
  }
  return parsed;
}

function decodeEnvelopeOutput(
  encoded: string | undefined,
  expectedBytes: number,
): string {
  if (
    encoded === undefined ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw new Error("Daytona command output envelope contains invalid base64");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== expectedBytes) {
    throw new Error(
      "Daytona command output envelope has an invalid byte count",
    );
  }
  return decoded.toString("utf8");
}

export async function validateSourceArchive(
  path: string,
  expectedBlobs?: ReadonlyMap<string, string>,
): Promise<void> {
  let entries = 0;
  let totalBytes = 0;
  const normalizedPaths = new Set<string>();
  const archivedFiles = new Set<string>();
  const contentChecks: Promise<void>[] = [];
  let validationError: Error | undefined;
  const reject = (message: string) => {
    validationError ??= new Error(message);
  };
  await tar.t({
    file: path,
    onentry: (entry) => {
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        reject("Candidate archive contains too many entries");
      }
      if (!["File", "OldFile", "Directory"].includes(entry.type)) {
        reject(
          `Candidate archive contains unsupported entry type ${entry.type}`,
        );
      }
      if (
        entry.size < 0 ||
        entry.size > MAX_ARCHIVE_FILE_BYTES ||
        totalBytes + entry.size > MAX_ARCHIVE_BYTES
      ) {
        reject("Candidate archive expanded size exceeds limits");
      }
      totalBytes += entry.size;

      const normalized = posix.normalize(entry.path);
      if (
        entry.path.includes("\0") ||
        posix.isAbsolute(entry.path) ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized === ".git" ||
        normalized.startsWith(".git/")
      ) {
        reject("Candidate archive contains an unsafe path");
      }
      const collisionKey = normalized.toLocaleLowerCase("en-US");
      if (normalizedPaths.has(collisionKey)) {
        reject("Candidate archive contains colliding paths");
      }
      normalizedPaths.add(collisionKey);
      if (entry.type !== "Directory") {
        archivedFiles.add(normalized);
        const expectedOid = expectedBlobs?.get(normalized);
        if (expectedBlobs && !expectedOid) {
          reject(
            "Candidate archive contains a file outside its frozen Git tree",
          );
        }
        if (expectedOid) {
          const hash = createHash(
            expectedOid.length === 40 ? "sha1" : "sha256",
          );
          hash.update(`blob ${entry.size}\0`);
          contentChecks.push(
            new Promise<void>((resolve) => {
              entry.on("data", (chunk: Buffer) => hash.update(chunk));
              entry.once("error", () => {
                reject("Candidate archive file could not be hashed");
                resolve();
              });
              entry.once("end", () => {
                if (hash.digest("hex") !== expectedOid) {
                  reject(
                    "Candidate archive file bytes do not match the frozen Git tree",
                  );
                }
                resolve();
              });
            }),
          );
        }
      }
    },
  });
  await Promise.all(contentChecks);
  if (validationError) {
    throw validationError;
  }
  if (entries === 0) {
    throw new Error("Candidate archive is empty");
  }
  if (
    expectedBlobs &&
    (archivedFiles.size !== expectedBlobs.size ||
      Array.from(expectedBlobs.keys()).some(
        (expected) => !archivedFiles.has(expected),
      ))
  ) {
    throw new Error("Candidate archive does not match its frozen Git tree");
  }
}

export function parseGitTreeManifest(
  manifest: Buffer,
): ReadonlyMap<string, string> {
  if (manifest.length === 0 || manifest.at(-1) !== 0) {
    throw new Error("Frozen Git tree manifest is empty or malformed");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      manifest.subarray(0, -1),
    );
  } catch {
    throw new Error("Frozen Git tree manifest contains a non-UTF-8 path");
  }
  const blobs = new Map<string, string>();
  for (const entry of decoded.split("\0")) {
    const parsed =
      /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(
        entry,
      );
    if (!parsed) {
      throw new Error("Frozen Git tree manifest contains an unsupported entry");
    }
    const [, , oid, path] = parsed;
    if (!oid || !path) {
      throw new Error("Frozen Git tree manifest is malformed");
    }
    const normalized = posix.normalize(path);
    if (
      path !== normalized ||
      posix.isAbsolute(path) ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized === ".git" ||
      normalized.startsWith(".git/") ||
      blobs.has(normalized)
    ) {
      throw new Error("Frozen Git tree manifest contains an unsafe path");
    }
    blobs.set(normalized, oid);
    if (blobs.size > MAX_ARCHIVE_ENTRIES) {
      throw new Error("Frozen Git tree manifest contains too many entries");
    }
  }
  return blobs;
}

async function validateControllerExport(
  source: ExportedWorkspace,
): Promise<void> {
  const [archiveStat, directoryStat] = await Promise.all([
    stat(source.archivePath),
    stat(source.directory),
  ]);
  if (
    !archiveStat.isFile() ||
    archiveStat.size === 0 ||
    archiveStat.size > MAX_ARCHIVE_BYTES ||
    !directoryStat.isDirectory() ||
    !/^[a-f0-9]{64}$/.test(source.archiveSha256) ||
    !/^[a-f0-9]{64}$/.test(source.contentDigest)
  ) {
    throw new Error("Controller source export is invalid");
  }
  if ((await sha256File(source.archivePath)) !== source.archiveSha256) {
    throw new Error("Controller source export digest does not match");
  }
  await validateSourceArchive(source.archivePath);
  const validationDirectory = await mkdtemp(
    join(tmpdir(), "buildlabs-controller-source-"),
  );
  try {
    await tar.x({
      cwd: validationDirectory,
      file: source.archivePath,
      preservePaths: false,
      unlink: true,
    });
    if (
      (await sourceTreeDigest(validationDirectory)) !== source.contentDigest
    ) {
      throw new Error(
        "Controller source content digest does not match its validated archive",
      );
    }
  } finally {
    await rm(validationDirectory, { recursive: true, force: true });
  }
}

async function resolveSandboxWorkDir(
  sandbox: Sandbox,
  signal?: AbortSignal,
): Promise<string> {
  const configured = (await withAbort(sandbox.getWorkDir(), signal)) ?? ".";
  const result = await withAbort(
    sandbox.process.executeCommand("pwd", configured, {}, 30),
    signal,
  );
  const workDir = result.result?.trim().split(/\s+/).at(-1);
  if (result.exitCode !== 0 || !workDir || !posix.isAbsolute(workDir)) {
    throw new Error("Daytona sandbox returned an invalid working directory");
  }
  return workDir;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

export async function sourceTreeDigest(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const path = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new Error(
          "Controller source tree contains an unsupported filesystem entry",
        );
      }
    }
  };
  await visit(root, "");
  files.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );

  const hash = createHash("sha256");
  hash.update("buildlabs-source-tree-v1\0");
  for (const path of files) {
    const absolutePath = join(root, ...path.split("/"));
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Controller source tree changed while being attested");
    }
    const mode = metadata.mode & 0o111 ? "100755" : "100644";
    hash.update(mode);
    hash.update("\0");
    hash.update(String(Buffer.byteLength(path, "utf8")));
    hash.update("\0");
    hash.update(path);
    hash.update("\0");
    hash.update(String(metadata.size));
    hash.update("\0");
    for await (const chunk of createReadStream(absolutePath)) {
      hash.update(chunk as Buffer);
    }
  }
  return hash.digest("hex");
}

export async function ensureDockerRuntime(
  sandbox: Sandbox,
  workDir: string,
  signal?: AbortSignal,
  options: DockerReadinessOptions = {},
): Promise<void> {
  const readinessTimeoutMs = normalizePositiveInteger(
    options.readinessTimeoutMs,
    120_000,
  );
  const pollIntervalMs = normalizePositiveInteger(
    options.pollIntervalMs,
    1_000,
  );
  const inspectTimeoutSeconds = normalizePositiveInteger(
    options.inspectTimeoutSeconds,
    10,
  );
  const startedAt = Date.now();
  let attempts = 0;
  let lastExitCode: number | undefined;
  let lastError: string | undefined;
  throwIfAborted(signal);
  const inspect = async (): Promise<boolean> => {
    attempts += 1;
    try {
      const result = await withAbort(
        sandbox.process.executeCommand(
          "docker info >/dev/null 2>&1",
          workDir,
          {},
          inspectTimeoutSeconds,
        ),
        signal,
      );
      lastExitCode = result.exitCode;
      lastError = undefined;
      return result.exitCode === 0;
    } catch (error) {
      throwIfAborted(signal);
      lastError = boundText(
        error instanceof Error ? error.message : "provider command failed",
        500,
      );
      return false;
    }
  };
  if (await inspect()) {
    return;
  }

  let daemon = await findDockerEntrypointCommand(sandbox, signal);
  if (!daemon) {
    const sessionId = "buildlabs-dockerd";
    try {
      await deleteDaytonaSessionIfPresent(sandbox.process, sessionId, signal);
      await withAbort(sandbox.process.createSession(sessionId), signal);
      const launch = await withAbort(
        sandbox.process.executeSessionCommand(
          sessionId,
          {
            command: "dockerd-entrypoint.sh",
            runAsync: true,
            suppressInputEcho: true,
          },
          30,
        ),
        signal,
      );
      daemon = {
        commandId: launch.cmdId,
        sessionId,
        usesEntrypointLogs: false,
      };
    } catch (error) {
      throwIfAborted(signal);
      throw new DaytonaDockerRuntimeError(
        `The Daytona sandbox Docker daemon could not be launched: ${boundText(error instanceof Error ? error.message : "provider session failure", 1_000)}`,
        { cause: error },
      );
    }
  }

  while (Date.now() - startedAt < readinessTimeoutMs) {
    const remainingMs = readinessTimeoutMs - (Date.now() - startedAt);
    await abortableDelay(Math.min(pollIntervalMs, remainingMs), signal);
    if (Date.now() - startedAt >= readinessTimeoutMs) {
      break;
    }
    if (await inspect()) {
      return;
    }
    const exited = await dockerDaemonExitDiagnostic(sandbox, daemon, signal);
    if (exited) {
      throw new DaytonaDockerRuntimeError(
        `The Daytona sandbox Docker daemon exited before readiness with code ${exited.exitCode}: ${exited.logs}`,
      );
    }
  }
  const elapsedSeconds = Math.ceil((Date.now() - startedAt) / 1_000);
  const lastOutcome =
    lastError !== undefined
      ? `last probe error: ${lastError}`
      : `last probe exit code: ${String(lastExitCode ?? "unknown")}`;
  throw new DaytonaDockerRuntimeError(
    `The Daytona sandbox Docker daemon did not become ready within the ${Math.ceil(readinessTimeoutMs / 1_000)}-second bound after ${attempts} probes (${elapsedSeconds} seconds elapsed; ${lastOutcome})`,
  );
}

export interface DockerReadinessOptions {
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
  inspectTimeoutSeconds?: number;
}

interface FailedDaytonaSandbox {
  id: string;
  delete(timeout: number, wait: boolean): Promise<void>;
}

interface DockerDaemonCommand {
  sessionId: string;
  commandId: string;
  usesEntrypointLogs: boolean;
}

export async function initializeDaytonaSandboxWithDockerRetry<T>(
  createSandbox: () => Promise<Sandbox>,
  initialize: (sandbox: Sandbox) => Promise<T>,
  signal?: AbortSignal,
  maxAttempts = MAX_DOCKER_SANDBOX_INITIALIZATION_ATTEMPTS,
): Promise<T> {
  const attempts = normalizePositiveInteger(
    maxAttempts,
    MAX_DOCKER_SANDBOX_INITIALIZATION_ATTEMPTS,
  );
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(signal);
    const sandbox = await createSandbox();
    try {
      return await initialize(sandbox);
    } catch (error) {
      await cleanupFailedDaytonaSandbox(sandbox, error);
      throwIfAborted(signal);
      lastError = error;
      if (
        !(error instanceof DaytonaDockerRuntimeError) ||
        attempt === attempts
      ) {
        throw error;
      }
    }
  }
  throw lastError;
}

export async function cleanupFailedDaytonaSandbox(
  sandbox: FailedDaytonaSandbox,
  initializationError: unknown,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<void> {
  const attempts = normalizePositiveInteger(options.attempts, 3);
  const retryDelayMs = normalizePositiveInteger(options.retryDelayMs, 1_000);
  let cleanupError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sandbox.delete(120, true);
      return;
    } catch (error) {
      cleanupError = error;
      if (attempt < attempts) {
        await abortableDelay(retryDelayMs, undefined);
      }
    }
  }
  throw new AggregateError(
    [initializationError, cleanupError],
    `Daytona sandbox ${sandbox.id} initialization failed and cleanup did not complete after ${attempts} attempts`,
  );
}

async function dockerDaemonExitDiagnostic(
  sandbox: Sandbox,
  daemon: DockerDaemonCommand,
  signal?: AbortSignal,
): Promise<{ exitCode: number; logs: string } | undefined> {
  try {
    const command = await withAbort(
      sandbox.process.getSessionCommand(daemon.sessionId, daemon.commandId),
      signal,
    );
    if (command.exitCode === undefined) {
      return undefined;
    }
    const logs = daemon.usesEntrypointLogs
      ? await withAbort(sandbox.process.getEntrypointLogs(), signal)
      : await withAbort(
          sandbox.process.getSessionCommandLogs(
            daemon.sessionId,
            daemon.commandId,
          ),
          signal,
        );
    const diagnostic = logs.stderr || logs.stdout || logs.output || "no logs";
    return {
      exitCode: command.exitCode,
      logs: boundText(diagnostic, 2_000),
    };
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof DaytonaNotFoundError) {
      return undefined;
    }
    return undefined;
  }
}

async function findDockerEntrypointCommand(
  sandbox: Sandbox,
  signal?: AbortSignal,
): Promise<DockerDaemonCommand | undefined> {
  try {
    const session = await withAbort(
      sandbox.process.getEntrypointSession(),
      signal,
    );
    const command = session.commands.find((entry) =>
      /(?:^|[/\s])dockerd(?:-entrypoint\.sh)?(?:\s|$)/u.test(entry.command),
    );
    return command
      ? {
          sessionId: session.sessionId,
          commandId: command.id,
          usesEntrypointLogs: true,
        }
      : undefined;
  } catch (_error) {
    throwIfAborted(signal);
    return undefined;
  }
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(1, Math.trunc(value));
}

function relativeWorkspacePath(workDir: string, path: string): string {
  const absoluteWorkDir = resolve(workDir);
  const absolutePath = resolve(path);
  if (
    absolutePath === absoluteWorkDir ||
    absolutePath.startsWith(`${absoluteWorkDir}${sep}`)
  ) {
    const relativePath = relative(absoluteWorkDir, absolutePath);
    return relativePath.length > 0 ? relativePath.split(sep).join("/") : ".";
  }
  return basename(path);
}

interface DaytonaSessionDeleter {
  deleteSession(sessionId: string): Promise<void>;
}

export async function deleteDaytonaSessionIfPresent(
  process: DaytonaSessionDeleter,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  try {
    await process.deleteSession(sessionId);
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) {
      throw error;
    }
  }
  throwIfAborted(signal);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Build run aborted");
  }
}

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return operation;
  }
  throwIfAborted(signal);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      rejectPromise(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Build run aborted"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(
          error instanceof Error
            ? error
            : new Error("Daytona operation failed", { cause: error }),
        );
      },
    );
  });
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, milliseconds);
    });
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Build run aborted"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
