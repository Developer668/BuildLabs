import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import sharp from "sharp";

import {
  type CustomerAliasContext,
  dashboardAliasSecret,
  opaqueAlias,
  resolveCustomerAliasContext,
} from "./aliases";
import {
  DashboardBffError,
  asRecord,
  bffErrorResponse,
  customerJson,
  readBoundedJson,
  safeInteger,
  safeString,
  safeTimestamp,
} from "./http";
import {
  type CustomerBuilderFence,
  customerProjectionRegistry,
} from "./projection-registry";
import {
  CustomerWipFrameStore,
  customerWipFrameStore,
} from "./wip-frame-store";

export { CustomerWipFrameStore, customerWipFrameStore };

const MAX_ENCODED_BODY_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_PNG_BYTES = 2_500_000;
const MAX_OUTPUT_PNG_BYTES = 2_500_000;
const MAX_FRAME_WIDTH = 1_440;
const MAX_FRAME_HEIGHT = 900;
const MIN_FRAME_WIDTH = 320;
const MIN_FRAME_HEIGHT = 180;
const MAX_FRAME_PIXELS = MAX_FRAME_WIDTH * MAX_FRAME_HEIGHT;
const PRIVACY_CELL_SIZE_PX = 24;
const PRIVACY_BLUR_SIGMA = 1;
const FRAME_TTL_MS = 60_000;
const MIN_CAPTURE_INTERVAL_MS = 2_000;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const FRAME_ALIAS_PATTERN = /^frm_[A-Za-z0-9_-]{22}$/;

export async function handleInternalWipFrameIngest(
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return customerJson(
      { error: "method_not_allowed", message: "POST is required" },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  try {
    requireInternalIngest(request);
    const parsed = parseFrameIngest(
      await readBoundedJson(request, MAX_ENCODED_BODY_BYTES),
    );
    const now = Date.now();
    const capturedAtMs = Date.parse(parsed.capturedAt);
    let sanitized: Awaited<ReturnType<typeof sanitizePng>>;
    try {
      requireSanitizationPolicy(parsed.sanitizationPolicyDigest);
      requireSanitizationReceipt(parsed);
      sanitized = await sanitizePng(parsed.pngBase64, {
        builderDisplayName: parsed.builderDisplayName,
        capturedAt: parsed.capturedAt,
        contractVersion: parsed.contractVersion,
      });
    } catch (error) {
      customerWipFrameStore.markBlocked(
        {
          projectId: parsed.projectId,
          runId: parsed.runId,
          candidateId: parsed.candidateId,
          contractVersion: parsed.contractVersion,
          expiresAtMs: Math.min(
            now + FRAME_TTL_MS,
            capturedAtMs + FRAME_TTL_MS,
          ),
        },
        now,
      );
      throw error;
    }
    const digest = createHash("sha256").update(sanitized.png).digest("hex");
    const frameId = opaqueAlias(
      "frm",
      [
        parsed.projectId,
        parsed.runId,
        parsed.candidateId,
        parsed.contractVersion,
        parsed.capturedAt,
        digest,
      ].join("\0"),
      dashboardAliasSecret(),
    );
    const frame = customerWipFrameStore.put(
      {
        projectId: parsed.projectId,
        runId: parsed.runId,
        candidateId: parsed.candidateId,
        contractVersion: parsed.contractVersion,
        frameId,
        capturedAt: parsed.capturedAt,
        expiresAtMs: Math.min(now + FRAME_TTL_MS, capturedAtMs + FRAME_TTL_MS),
        width: sanitized.width,
        height: sanitized.height,
        png: sanitized.png,
      },
      now,
      MIN_CAPTURE_INTERVAL_MS,
    );
    return customerJson(
      {
        accepted: true,
        frameId: frame.frameId,
        expiresAt: frame.expiresAt,
      },
      { status: 202 },
    );
  } catch (error) {
    return bffErrorResponse(error);
  }
}

export function handleCustomerWipFrame(input: {
  request: Request;
  projectAlias: string;
  builderAlias: string;
  frameId: string;
}): Response {
  try {
    if (!FRAME_ALIAS_PATTERN.test(input.frameId)) {
      throw frameUnavailable();
    }
    const { frame } = resolveCustomerFrame({
      request: input.request,
      projectAlias: input.projectAlias,
      builderAlias: input.builderAlias,
      frameId: input.frameId,
    });
    return new Response(new Uint8Array(frame.png), {
      status: 200,
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": 'inline; filename="unverified-wip.png"',
        "content-length": String(frame.png.byteLength),
        "content-security-policy":
          "default-src 'none'; sandbox; frame-ancestors 'self'",
        "content-type": "image/png",
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-buildlabs-content-status": "unverified-wip",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return bffErrorResponse(error);
  }
}

export function handleCustomerWipMetadata(input: {
  request: Request;
  projectAlias: string;
  builderAlias: string;
}): Response {
  try {
    const { aliases, fence } = resolveCustomerFence(input);
    const frame = customerWipFrameStore.get(fence);
    if (frame === undefined) {
      if (customerWipFrameStore.isBlocked(fence)) {
        return customerJson({
          state: "blocked",
          customerRenderable: false,
          latestFrameId: null,
          capturedAt: null,
          width: null,
          height: null,
          expiresAt: null,
        });
      }
      throw frameUnavailable();
    }
    const publicFrameId = customerFrameAlias(
      frame.metadata.frameId,
      aliases.sessionBinding,
    );
    return customerJson({
      state: frame.metadata.stale ? "stale" : "live_unverified",
      customerRenderable: true,
      latestFrameId: publicFrameId,
      capturedAt: frame.metadata.capturedAt,
      width: frame.metadata.width,
      height: frame.metadata.height,
      expiresAt: frame.metadata.expiresAt,
    });
  } catch (error) {
    return bffErrorResponse(error);
  }
}

function parseFrameIngest(value: unknown): {
  projectId: string;
  runId: string;
  candidateId: string;
  contractVersion: number;
  builderDisplayName: "Builder 1" | "Builder 2" | "Builder 3" | "Builder 4";
  capturedAt: string;
  sanitizationPolicyDigest: string;
  sanitizedPngDigest: string;
  sanitizationReceipt: string;
  pngBase64: string;
} {
  const record = asRecord(value);
  if (
    record === undefined ||
    Object.keys(record).some(
      (key) =>
        ![
          "projectId",
          "runId",
          "candidateId",
          "contractVersion",
          "builderDisplayName",
          "capturedAt",
          "sanitizationPolicyDigest",
          "sanitizedPngDigest",
          "sanitizationReceipt",
          "pngBase64",
        ].includes(key),
    )
  ) {
    throw invalidFrame();
  }
  const projectId = safeString(record.projectId, 64);
  const runId = safeString(record.runId, 256);
  const candidateId = safeString(record.candidateId, 256);
  const contractVersion = safeInteger(record.contractVersion, 1);
  const builderDisplayName =
    record.builderDisplayName === "Builder 1" ||
    record.builderDisplayName === "Builder 2" ||
    record.builderDisplayName === "Builder 3" ||
    record.builderDisplayName === "Builder 4"
      ? record.builderDisplayName
      : undefined;
  const capturedAt = safeTimestamp(record.capturedAt);
  const sanitizationPolicyDigest = safeString(
    record.sanitizationPolicyDigest,
    64,
  );
  const sanitizedPngDigest = safeString(record.sanitizedPngDigest, 64);
  const sanitizationReceipt = safeString(record.sanitizationReceipt, 64);
  const pngBase64 = safeString(record.pngBase64, 3_500_000);
  const capturedAtMs =
    capturedAt === undefined ? Number.NaN : Date.parse(capturedAt);
  const now = Date.now();
  if (
    projectId === undefined ||
    !PROJECT_ID_PATTERN.test(projectId) ||
    runId === undefined ||
    !INTERNAL_ID_PATTERN.test(runId) ||
    candidateId === undefined ||
    !INTERNAL_ID_PATTERN.test(candidateId) ||
    contractVersion === undefined ||
    builderDisplayName === undefined ||
    capturedAt === undefined ||
    capturedAtMs <= now - FRAME_TTL_MS ||
    capturedAtMs > now + 5_000 ||
    sanitizationPolicyDigest === undefined ||
    !/^[a-f0-9]{64}$/i.test(sanitizationPolicyDigest) ||
    sanitizedPngDigest === undefined ||
    !/^[a-f0-9]{64}$/i.test(sanitizedPngDigest) ||
    sanitizationReceipt === undefined ||
    !/^[a-f0-9]{64}$/i.test(sanitizationReceipt) ||
    pngBase64 === undefined ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(pngBase64)
  ) {
    throw invalidFrame();
  }
  return {
    projectId,
    runId,
    candidateId,
    contractVersion,
    builderDisplayName,
    capturedAt,
    sanitizationPolicyDigest,
    sanitizedPngDigest,
    sanitizationReceipt,
    pngBase64,
  };
}

async function sanitizePng(
  encoded: string,
  watermark: {
    builderDisplayName: string;
    capturedAt: string;
    contractVersion: number;
  },
): Promise<{ png: Buffer; width: number; height: number }> {
  const input = Buffer.from(encoded, "base64");
  if (
    input.byteLength === 0 ||
    input.byteLength > MAX_INPUT_PNG_BYTES ||
    input.subarray(0, PNG_SIGNATURE.length).compare(PNG_SIGNATURE) !== 0
  ) {
    throw invalidFrame();
  }
  try {
    const pipeline = sharp(input, {
      failOn: "warning",
      limitInputPixels: MAX_FRAME_PIXELS,
      sequentialRead: true,
    });
    const metadata = await pipeline.metadata();
    if (
      metadata.format !== "png" ||
      (metadata.pages !== undefined && metadata.pages !== 1) ||
      metadata.width === undefined ||
      metadata.height === undefined ||
      metadata.width < MIN_FRAME_WIDTH ||
      metadata.height < MIN_FRAME_HEIGHT ||
      metadata.width > MAX_FRAME_WIDTH ||
      metadata.height > MAX_FRAME_HEIGHT ||
      metadata.width * metadata.height > MAX_FRAME_PIXELS
    ) {
      throw invalidFrame();
    }
    const normalized = await pipeline
      .rotate()
      .png({
        compressionLevel: 9,
        progressive: false,
        palette: false,
      })
      .toBuffer();
    const normalizedMetadata = await sharp(normalized, {
      failOn: "warning",
      limitInputPixels: MAX_FRAME_PIXELS,
      sequentialRead: true,
    }).metadata();
    const width = normalizedMetadata.width;
    const height = normalizedMetadata.height;
    if (
      width === undefined ||
      height === undefined ||
      width < MIN_FRAME_WIDTH ||
      height < MIN_FRAME_HEIGHT ||
      width > MAX_FRAME_WIDTH ||
      height > MAX_FRAME_HEIGHT ||
      width * height > MAX_FRAME_PIXELS
    ) {
      throw invalidFrame();
    }
    const privacyWidth = Math.max(1, Math.ceil(width / PRIVACY_CELL_SIZE_PX));
    const privacyHeight = Math.max(1, Math.ceil(height / PRIVACY_CELL_SIZE_PX));
    const reducedLayout = await sharp(normalized, {
      failOn: "warning",
      limitInputPixels: MAX_FRAME_PIXELS,
      sequentialRead: true,
    })
      .resize(privacyWidth, privacyHeight, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      })
      .blur(PRIVACY_BLUR_SIGMA)
      .png({
        compressionLevel: 9,
        progressive: false,
        palette: false,
      })
      .toBuffer();
    const layoutOnly = await sharp(reducedLayout, {
      failOn: "warning",
      limitInputPixels: MAX_FRAME_PIXELS,
      sequentialRead: true,
    })
      .resize(width, height, {
        fit: "fill",
        kernel: sharp.kernel.nearest,
      })
      .png({
        compressionLevel: 9,
        progressive: false,
        palette: false,
      })
      .toBuffer();
    const bannerHeight = 56;
    const primaryLabel = escapeSvgText(
      [
        "UNVERIFIED WIP",
        "SANITIZED LAYOUT ONLY",
        `Contract v${watermark.contractVersion}`,
      ].join(" | "),
    );
    const captureLabel = escapeSvgText(
      `${watermark.builderDisplayName} | ${watermark.capturedAt}`,
    );
    const overlay = Buffer.from(
      `<svg width="${width}" height="${bannerHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#081217" fill-opacity="0.96"/><text x="10" y="21" fill="#ffffff" font-family="Arial, sans-serif" font-size="12" font-weight="700">${primaryLabel}</text><text x="10" y="43" fill="#c5d4d8" font-family="Arial, sans-serif" font-size="11">${captureLabel}</text></svg>`,
      "utf8",
    );
    const output = await sharp(layoutOnly)
      .composite([{ input: overlay, left: 0, top: 0 }])
      .png({
        compressionLevel: 9,
        progressive: false,
        palette: false,
      })
      .toBuffer();
    if (
      output.byteLength === 0 ||
      output.byteLength > MAX_OUTPUT_PNG_BYTES ||
      output.subarray(0, PNG_SIGNATURE.length).compare(PNG_SIGNATURE) !== 0
    ) {
      throw invalidFrame();
    }
    return { png: output, width, height };
  } catch (error) {
    if (error instanceof DashboardBffError) throw error;
    throw invalidFrame();
  }
}

function requireInternalIngest(request: Request): void {
  const configured = process.env.BUILDLABS_DASHBOARD_INTERNAL_TOKEN?.trim();
  const authorization = request.headers.get("authorization");
  if (
    configured === undefined ||
    Buffer.byteLength(configured, "utf8") < 32 ||
    authorization === null ||
    !authorization.startsWith("Bearer ") ||
    !constantTimeTextEqual(authorization.slice("Bearer ".length), configured)
  ) {
    throw new DashboardBffError(
      401,
      "internal_authentication_required",
      "Internal authentication is required",
    );
  }
}

function requireSanitizationPolicy(receivedDigest: string): void {
  const configured = process.env.BUILDLABS_DASHBOARD_WIP_POLICY_DIGEST?.trim();
  if (
    configured === undefined ||
    !/^[a-f0-9]{64}$/i.test(configured) ||
    !constantTimeTextEqual(
      receivedDigest.toLowerCase(),
      configured.toLowerCase(),
    )
  ) {
    throw new DashboardBffError(
      403,
      "wip_sanitization_policy_rejected",
      "The WIP frame sanitization receipt is invalid",
    );
  }
}

function requireSanitizationReceipt(input: {
  projectId: string;
  runId: string;
  candidateId: string;
  contractVersion: number;
  builderDisplayName: string;
  capturedAt: string;
  sanitizationPolicyDigest: string;
  sanitizedPngDigest: string;
  sanitizationReceipt: string;
  pngBase64: string;
}): void {
  const secret = process.env.BUILDLABS_DASHBOARD_WIP_ATTESTATION_SECRET?.trim();
  if (secret === undefined || Buffer.byteLength(secret, "utf8") < 32) {
    throw new DashboardBffError(
      503,
      "wip_sanitization_unconfigured",
      "The WIP sanitization boundary is unavailable",
    );
  }
  const sourcePngDigest = createHash("sha256")
    .update(Buffer.from(input.pngBase64, "base64"))
    .digest("hex");
  const expectedReceipt = createHmac("sha256", secret)
    .update(
      [
        "buildlabs.dashboard.wip-sanitization.v1",
        input.projectId,
        input.runId,
        input.candidateId,
        String(input.contractVersion),
        input.builderDisplayName,
        input.capturedAt,
        input.sanitizationPolicyDigest.toLowerCase(),
        sourcePngDigest,
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
  if (
    !constantTimeTextEqual(
      input.sanitizedPngDigest.toLowerCase(),
      sourcePngDigest,
    ) ||
    !constantTimeTextEqual(
      input.sanitizationReceipt.toLowerCase(),
      expectedReceipt,
    )
  ) {
    throw new DashboardBffError(
      403,
      "wip_sanitization_receipt_rejected",
      "The WIP sanitization receipt is invalid",
    );
  }
}

function resolveCustomerFrame(input: {
  request: Request;
  projectAlias: string;
  builderAlias: string;
  frameId?: string;
}): {
  frame: NonNullable<ReturnType<typeof customerWipFrameStore.get>>;
  publicFrameId: string;
} {
  const { aliases, fence } = resolveCustomerFence(input);
  const frame = customerWipFrameStore.get(fence);
  if (frame === undefined) {
    throw frameUnavailable();
  }
  const publicFrameId = customerFrameAlias(
    frame.metadata.frameId,
    aliases.sessionBinding,
  );
  if (
    input.frameId !== undefined &&
    !constantTimeTextEqual(input.frameId, publicFrameId)
  ) {
    throw frameUnavailable();
  }
  return { frame, publicFrameId };
}

function resolveCustomerFence(input: {
  request: Request;
  projectAlias: string;
  builderAlias: string;
}): { aliases: CustomerAliasContext; fence: CustomerBuilderFence } {
  const aliases = resolveCustomerAliasContext(
    input.request,
    input.projectAlias,
  );
  const fence = customerProjectionRegistry.get(
    aliases.projectAlias,
    input.builderAlias,
    aliases.sessionBinding,
  );
  if (
    fence === undefined ||
    fence.internalProjectId !== aliases.internalProjectId
  ) {
    throw frameUnavailable();
  }
  return { aliases, fence };
}

function customerFrameAlias(frameId: string, binding: string): string {
  return opaqueAlias("frm", `${frameId}\0${binding}`, dashboardAliasSecret());
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function invalidFrame(): DashboardBffError {
  return new DashboardBffError(
    400,
    "invalid_wip_frame",
    "The WIP frame is invalid",
  );
}

function frameUnavailable(): DashboardBffError {
  return new DashboardBffError(
    404,
    "wip_render_unavailable",
    "The requested WIP render is unavailable",
  );
}
