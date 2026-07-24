import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

import type { BuildAssignment } from "../domain/contract.js";
import type { RasterClaimReceipt } from "../domain/evidence.js";
import { canonicalJson, digestJson, sha256 } from "../lib/canonical-json.js";
import type {
  InspectedPage,
  ModelPort,
  RasterAssetMimeType,
  RasterClaimAsset,
  RasterClaimInspectionOutput,
  TraceSpan,
} from "../ports/index.js";
import { RasterClaimInspectionError } from "../ports/index.js";
import { createReceiptBase } from "./receipts.js";

export const MAX_RASTER_ASSETS = 64;
export const MAX_RASTER_ASSET_BYTES = 5 * 1_024 * 1_024;
export const MAX_RASTER_AGGREGATE_BYTES = 64 * 1_024 * 1_024;

const MAX_RENDERED_RASTER_ASSETS = 512;
const MAX_RENDERED_RASTER_BYTES = 6 * 1_024 * 1_024;
const MAX_MODEL_BATCH_ASSETS = 16;
const MAX_MODEL_BATCH_BASE64_BYTES = 8 * 1_024 * 1_024;
const MAX_WORKSPACE_ENTRIES = 10_000;
const MAX_DIRECTORY_DEPTH = 64;
const MAX_RELATIVE_PATH_BYTES = 4_096;
const MAX_APPROVED_FACT_POLICY_BYTES = 256 * 1_024;
const HEADER_BYTES = 32;

type RasterClaimErrorCode = NonNullable<RasterClaimReceipt["errorCode"]>;
type SourceRasterKind =
  | "avif"
  | "bmp"
  | "gif"
  | "heif"
  | "ico"
  | "jpeg"
  | "png"
  | "ppm"
  | "tiff"
  | "webp";

interface CollectedAsset extends RasterClaimAsset {
  relativePath: string;
  source: "rendered" | "workspace";
  sourceSizeBytes: number;
  modelSizeBytes: number;
}

interface ReceiptShape {
  provider: RasterClaimReceipt["provider"];
  status: RasterClaimReceipt["status"];
  assets: CollectedAsset[];
  matches: RasterClaimReceipt["matches"];
  unsupportedAssetIndices: number[];
  unverifiedAssetIndices: number[];
  modelDigest?: string;
  errorCode?: RasterClaimErrorCode;
}

class RasterAssetError extends Error {
  constructor(readonly code: RasterClaimErrorCode) {
    super(code);
  }
}

export interface RasterClaimInspectionRequest {
  runId: string;
  revisionHash: string;
  assignment: BuildAssignment;
  workspaceDirectory: string;
  pages: InspectedPage[];
  model: ModelPort;
  trace: TraceSpan;
  signal?: AbortSignal | undefined;
}

export async function inspectRasterClaims(
  request: RasterClaimInspectionRequest,
): Promise<RasterClaimReceipt> {
  const forbiddenClaimIndices = request.assignment.contract.forbiddenClaims.map(
    (_, index) => index,
  );
  const startedAt = new Date().toISOString();
  const claimSetDigest = sha256(
    canonicalJson(request.assignment.contract.forbiddenClaims),
  );
  const approvedFacts = request.assignment.contract.approvedFacts.map(
    (fact) => fact.statement,
  );
  const approvedFactSetDigest = sha256(canonicalJson(approvedFacts));
  const renderedInputDigest = renderedRasterInputDigest(request.pages);

  return request.trace.child(
    "claims.raster.gate",
    "score",
    {
      runId: request.runId,
      revisionHash: request.revisionHash,
      forbiddenClaimIndices,
      claimSetDigest,
      approvedFactSetDigest,
      renderedInputDigest,
    },
    async (gateSpan) => {
      if (
        Buffer.byteLength(canonicalJson(approvedFacts), "utf8") >
        MAX_APPROVED_FACT_POLICY_BYTES
      ) {
        const receipt = createVisualReceipt(request, startedAt, {
          provider: "controller",
          status: "ERROR",
          assets: [],
          matches: [],
          unsupportedAssetIndices: [],
          unverifiedAssetIndices: [],
          errorCode: "policy_bound_exceeded",
        });
        gateSpan.log({
          output: {
            status: receipt.status,
            errorCode: receipt.errorCode,
            assetCount: 0,
          },
        });
        return receipt;
      }
      let assets: CollectedAsset[] = [];
      try {
        const workspaceAssets = await collectRasterAssets(
          request.workspaceDirectory,
          request.signal,
        );
        const renderedAssets = collectRenderedAssets(
          request.pages,
          workspaceAssets.length,
          request.signal,
        );
        assets = [...workspaceAssets, ...renderedAssets];
      } catch (error) {
        throwIfAborted(request.signal, error);
        const errorCode =
          error instanceof RasterAssetError
            ? error.code
            : ("workspace_read_failed" as const);
        const receipt = createVisualReceipt(request, startedAt, {
          provider: "controller",
          status: "ERROR",
          assets: [],
          matches: [],
          unsupportedAssetIndices: [],
          unverifiedAssetIndices: [],
          errorCode,
        });
        gateSpan.log({
          output: { status: receipt.status, errorCode, assetCount: 0 },
        });
        return receipt;
      }

      if (assets.length === 0) {
        const receipt = createVisualReceipt(request, startedAt, {
          provider: "controller",
          status: "PASS",
          assets,
          matches: [],
          unsupportedAssetIndices: [],
          unverifiedAssetIndices: [],
        });
        gateSpan.log({
          output: { status: receipt.status, assetCount: 0, matchCount: 0 },
        });
        return receipt;
      }

      if (!request.model.inspectRasterClaims) {
        const receipt = createVisualReceipt(request, startedAt, {
          provider: "controller",
          status: "ERROR",
          assets,
          matches: [],
          unsupportedAssetIndices: [],
          unverifiedAssetIndices: [],
          errorCode: "model_capability_unavailable",
        });
        gateSpan.log({
          output: {
            status: receipt.status,
            errorCode: receipt.errorCode,
            assetCount: receipt.assetCount,
          },
        });
        return receipt;
      }

      let output: RasterClaimInspectionOutput;
      try {
        output = await inspectBatches(
          request,
          gateSpan,
          assets,
          forbiddenClaimIndices,
        );
      } catch (error) {
        throwIfAborted(request.signal, error);
        const errorCode =
          error instanceof RasterClaimInspectionError
            ? ("model_response_invalid" as const)
            : ("provider_error" as const);
        const receipt = createVisualReceipt(request, startedAt, {
          provider: "fireworks",
          status: "ERROR",
          assets,
          matches: [],
          unsupportedAssetIndices: [],
          unverifiedAssetIndices: [],
          errorCode,
        });
        gateSpan.log({
          output: {
            status: receipt.status,
            errorCode,
            assetCount: receipt.assetCount,
          },
        });
        return receipt;
      }

      const matches = output.results
        .filter((result) => result.status === "MATCH")
        .map((result) => ({
          assetIndex: result.assetIndex,
          assetSha256: assets[result.assetIndex]!.sha256,
          forbiddenClaimIndices: result.matchedForbiddenClaimIndices,
        }));
      const unverifiedAssetIndices = output.results
        .filter((result) => result.status === "UNVERIFIED")
        .map((result) => result.assetIndex);
      const unsupportedAssetIndices = output.results
        .filter((result) => result.status === "UNSUPPORTED")
        .map((result) => result.assetIndex);
      const shape: ReceiptShape =
        unverifiedAssetIndices.length > 0
          ? {
              provider: "fireworks",
              status: "ERROR",
              assets,
              matches: [],
              unsupportedAssetIndices: [],
              unverifiedAssetIndices,
              modelDigest: output.modelDigest,
              errorCode: "provider_unverified",
            }
          : {
              provider: "fireworks",
              status:
                matches.length > 0 || unsupportedAssetIndices.length > 0
                  ? "FAIL"
                  : "PASS",
              assets,
              matches,
              unsupportedAssetIndices,
              unverifiedAssetIndices: [],
              modelDigest: output.modelDigest,
            };
      const receipt = createVisualReceipt(request, startedAt, shape);
      gateSpan.log({
        output: {
          status: receipt.status,
          assetCount: receipt.assetCount,
          matchCount: receipt.matches.length,
          unsupportedAssetIndices: receipt.unsupportedAssetIndices,
          unverifiedAssetIndices: receipt.unverifiedAssetIndices,
          modelDigest: receipt.modelDigest,
        },
      });
      return receipt;
    },
  );
}

async function inspectBatches(
  request: RasterClaimInspectionRequest,
  gateSpan: TraceSpan,
  assets: CollectedAsset[],
  forbiddenClaimIndices: number[],
): Promise<RasterClaimInspectionOutput> {
  const batches = createModelBatches(assets);
  const allResults: RasterClaimInspectionOutput["results"] = [];
  let modelDigest: string | undefined;

  for (const [batchIndex, batch] of batches.entries()) {
    throwIfAborted(request.signal);
    const output = await gateSpan.child(
      `fireworks.vision.forbidden-claims.batch-${batchIndex}`,
      "llm",
      {
        revisionHash: request.revisionHash,
        forbiddenClaimIndices,
        assetIndices: batch.map((asset) => asset.index),
        assetDigests: batch.map((asset) => asset.sha256),
        modelInputDigests: batch.map((asset) => asset.imageSha256),
        modelInputBytes: batch.reduce(
          (total, asset) => total + asset.modelSizeBytes,
          0,
        ),
      },
      async (modelSpan) => {
        const result = await request.model.inspectRasterClaims!(
          {
            forbiddenClaims:
              request.assignment.contract.forbiddenClaims.slice(),
            approvedFacts: request.assignment.contract.approvedFacts.map(
              (fact) => fact.statement,
            ),
            assets: batch.map(
              ({ sha256, imageSha256, mimeType, base64 }, index) => ({
                index,
                sha256,
                imageSha256,
                mimeType,
                base64,
              }),
            ),
          },
          request.signal,
        );
        const normalized = validateModelOutput(
          result,
          batch.length,
          forbiddenClaimIndices,
        );
        modelSpan.log({
          output: {
            modelDigest: normalized.modelDigest,
            results: normalized.results.map((item) => ({
              assetIndex: batch[item.assetIndex]!.index,
              status: item.status,
              matchedForbiddenClaimIndices: item.matchedForbiddenClaimIndices,
            })),
          },
        });
        return normalized;
      },
    );
    if (modelDigest && output.modelDigest !== modelDigest) {
      throw new RasterClaimInspectionError(
        "MODEL_RESPONSE_INVALID",
        "Raster claim batches used inconsistent models",
      );
    }
    modelDigest = output.modelDigest;
    allResults.push(
      ...output.results.map((result) => ({
        ...result,
        assetIndex: batch[result.assetIndex]!.index,
      })),
    );
  }

  if (!modelDigest || allResults.length !== assets.length) {
    throw new RasterClaimInspectionError(
      "MODEL_RESPONSE_INVALID",
      "Raster claim batches did not bind every asset",
    );
  }
  allResults.sort((left, right) => left.assetIndex - right.assetIndex);
  return { modelDigest, results: allResults };
}

async function collectRasterAssets(
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<CollectedAsset[]> {
  const root = resolve(workspaceDirectory);
  const paths: string[] = [];
  const directories = [{ absolute: root, depth: 0 }];
  let entryCount = 0;

  while (directories.length > 0) {
    throwIfAborted(signal);
    const current = directories.pop()!;
    let directory;
    try {
      directory = await opendir(current.absolute);
    } catch {
      throw new RasterAssetError("workspace_read_failed");
    }
    for await (const entry of directory) {
      throwIfAborted(signal);
      entryCount += 1;
      if (entryCount > MAX_WORKSPACE_ENTRIES) {
        throw new RasterAssetError("asset_bound_exceeded");
      }
      const absolute = resolve(current.absolute, entry.name);
      const child = relative(root, absolute);
      if (
        child.length === 0 ||
        child === ".." ||
        child.startsWith(`..${sep}`) ||
        Buffer.byteLength(child, "utf8") > MAX_RELATIVE_PATH_BYTES
      ) {
        throw new RasterAssetError("invalid_asset");
      }
      let metadata;
      try {
        metadata = await lstat(absolute);
      } catch {
        throw new RasterAssetError("workspace_read_failed");
      }
      if (metadata.isSymbolicLink()) {
        throw new RasterAssetError("invalid_asset");
      }
      if (metadata.isDirectory()) {
        if (current.depth >= MAX_DIRECTORY_DEPTH) {
          throw new RasterAssetError("asset_bound_exceeded");
        }
        directories.push({ absolute, depth: current.depth + 1 });
      } else if (metadata.isFile()) {
        paths.push(child);
      } else {
        throw new RasterAssetError("invalid_asset");
      }
    }
  }

  paths.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  const assets: CollectedAsset[] = [];
  let aggregateBytes = 0;

  for (const path of paths) {
    throwIfAborted(signal);
    const absolute = resolve(root, path);
    let handle;
    try {
      handle = await open(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new RasterAssetError("invalid_asset");
      }
      const header = Buffer.alloc(Math.min(HEADER_BYTES, metadata.size));
      if (header.length > 0) {
        await handle.read(header, 0, header.length, 0);
      }
      const detected = detectRaster(header);
      const expected = expectedRasterFromExtension(path);
      if (expected === "unsupported") {
        throw new RasterAssetError("unsupported_asset_format");
      }
      if (expected && expected !== detected) {
        throw new RasterAssetError("invalid_asset");
      }
      if (!detected) {
        continue;
      }
      if (metadata.size === 0 || metadata.size > MAX_RASTER_ASSET_BYTES) {
        throw new RasterAssetError("asset_bound_exceeded");
      }
      if (assets.length >= MAX_RASTER_ASSETS) {
        throw new RasterAssetError("asset_bound_exceeded");
      }
      aggregateBytes += metadata.size;
      if (aggregateBytes > MAX_RASTER_AGGREGATE_BYTES) {
        throw new RasterAssetError("asset_bound_exceeded");
      }
      const bytes = await handle.readFile();
      if (bytes.length !== metadata.size || detectRaster(bytes) !== detected) {
        throw new RasterAssetError("invalid_asset");
      }
      const mimeType = sourceRasterMimeType(detected, bytes);
      if (!mimeType) {
        continue;
      }
      assets.push({
        index: assets.length,
        relativePath: path,
        source: "workspace",
        sourceSizeBytes: bytes.length,
        modelSizeBytes: bytes.length,
        sha256: sha256(bytes),
        imageSha256: sha256(bytes),
        mimeType,
        base64: bytes.toString("base64"),
      });
    } catch (error) {
      throwIfAborted(signal, error);
      if (error instanceof RasterAssetError) {
        throw error;
      }
      throw new RasterAssetError("workspace_read_failed");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return assets;
}

function collectRenderedAssets(
  pages: InspectedPage[],
  firstIndex: number,
  signal?: AbortSignal,
): CollectedAsset[] {
  const sortedPages = pages
    .slice()
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.path, "utf8"),
        Buffer.from(right.path, "utf8"),
      ),
    );
  if (new Set(sortedPages.map((page) => page.path)).size !== pages.length) {
    throw new RasterAssetError("invalid_asset");
  }
  const assets: CollectedAsset[] = [];
  let aggregateBytes = 0;

  for (const [pageIndex, page] of sortedPages.entries()) {
    throwIfAborted(signal);
    if (!page.screenshotBase64s || page.screenshotBase64s.length === 0) {
      throw new RasterAssetError("invalid_asset");
    }
    for (const [tileIndex, encoded] of page.screenshotBase64s.entries()) {
      if (assets.length >= MAX_RENDERED_RASTER_ASSETS) {
        throw new RasterAssetError("asset_bound_exceeded");
      }
      const bytes = decodeCanonicalBase64(encoded);
      if (!bytes || !hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) {
        throw new RasterAssetError("invalid_asset");
      }
      aggregateBytes += bytes.length;
      if (aggregateBytes > MAX_RENDERED_RASTER_BYTES) {
        throw new RasterAssetError("asset_bound_exceeded");
      }
      assets.push({
        index: firstIndex + assets.length,
        relativePath: `rendered/${pageIndex}/${tileIndex}`,
        source: "rendered",
        sourceSizeBytes: bytes.length,
        modelSizeBytes: bytes.length,
        sha256: sha256(bytes),
        imageSha256: sha256(bytes),
        mimeType: "image/png",
        base64: bytes.toString("base64"),
      });
    }
  }
  return assets;
}

function sourceRasterMimeType(
  kind: SourceRasterKind,
  bytes: Buffer,
): RasterAssetMimeType | undefined {
  switch (kind) {
    case "png":
      if (pngIsAnimatedOrMalformed(bytes)) {
        throw new RasterAssetError("multi_frame_asset");
      }
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "bmp":
      return "image/bmp";
    case "ppm":
      return "image/x-portable-pixmap";
    case "gif":
    case "tiff":
      throw new RasterAssetError("multi_frame_asset");
    case "avif":
    case "heif":
      if (isoImageIsSequenceOrMalformed(bytes)) {
        throw new RasterAssetError("multi_frame_asset");
      }
      return undefined;
    case "webp":
      if (webpIsAnimatedOrMalformed(bytes)) {
        throw new RasterAssetError("multi_frame_asset");
      }
      return undefined;
    case "ico":
      return undefined;
  }
}

function pngIsAnimatedOrMalformed(bytes: Buffer): boolean {
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) {
      return true;
    }
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!sawHeader && (type !== "IHDR" || length !== 13)) {
      return true;
    }
    sawHeader = true;
    if (type === "acTL") {
      return true;
    }
    if (type === "IEND") {
      sawEnd = length === 0 && chunkEnd === bytes.length;
      break;
    }
    offset = chunkEnd;
  }
  return !sawHeader || !sawEnd;
}

function webpIsAnimatedOrMalformed(bytes: Buffer): boolean {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    return true;
  }
  let offset = 12;
  let sawImage = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return true;
    }
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const unpaddedEnd = dataOffset + length;
    const chunkEnd = unpaddedEnd + (length % 2);
    if (chunkEnd > bytes.length) {
      return true;
    }
    if (type === "ANIM" || type === "ANMF") {
      return true;
    }
    if (type === "VP8X") {
      if (length !== 10 || (bytes[dataOffset]! & 0x02) !== 0) {
        return true;
      }
    }
    if (type === "VP8 " || type === "VP8L") {
      sawImage = true;
    }
    offset = chunkEnd;
  }
  return offset !== bytes.length || !sawImage;
}

function isoImageIsSequenceOrMalformed(bytes: Buffer): boolean {
  const brands = readIsoImageBrands(bytes);
  if (!brands) {
    return true;
  }
  const sequenceBrands = new Set([
    "avis",
    "hevc",
    "hevm",
    "hevs",
    "hevx",
    "msf1",
  ]);
  return brands.some((brand) => sequenceBrands.has(brand));
}

function readIsoImageBrands(bytes: Buffer): string[] | undefined {
  if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") {
    return undefined;
  }
  const size32 = bytes.readUInt32BE(0);
  let boxSize: number;
  let majorBrandOffset: number;
  let compatibleBrandsOffset: number;
  if (size32 === 1) {
    if (bytes.length < 24) {
      return undefined;
    }
    const extendedSize = bytes.readBigUInt64BE(8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }
    boxSize = Number(extendedSize);
    majorBrandOffset = 16;
    compatibleBrandsOffset = 24;
  } else {
    boxSize = size32 === 0 ? bytes.length : size32;
    majorBrandOffset = 8;
    compatibleBrandsOffset = 16;
  }
  if (
    boxSize > bytes.length ||
    boxSize < compatibleBrandsOffset ||
    (boxSize - compatibleBrandsOffset) % 4 !== 0
  ) {
    return undefined;
  }
  const brands = [
    bytes.toString("ascii", majorBrandOffset, majorBrandOffset + 4),
  ];
  for (let offset = compatibleBrandsOffset; offset < boxSize; offset += 4) {
    brands.push(bytes.toString("ascii", offset, offset + 4));
  }
  return brands;
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
  const bytes = Buffer.from(input, "base64");
  return bytes.toString("base64") === input ? bytes : undefined;
}

function createModelBatches(assets: CollectedAsset[]): CollectedAsset[][] {
  const batches: CollectedAsset[][] = [];
  let current: CollectedAsset[] = [];
  let base64Bytes = 0;

  for (const asset of assets) {
    const assetBase64Bytes = Buffer.byteLength(asset.base64, "ascii");
    if (assetBase64Bytes >= MAX_MODEL_BATCH_BASE64_BYTES) {
      throw new RasterAssetError("asset_bound_exceeded");
    }
    if (
      current.length >= MAX_MODEL_BATCH_ASSETS ||
      (current.length > 0 &&
        base64Bytes + assetBase64Bytes >= MAX_MODEL_BATCH_BASE64_BYTES)
    ) {
      batches.push(current);
      current = [];
      base64Bytes = 0;
    }
    current.push(asset);
    base64Bytes += assetBase64Bytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function detectRaster(bytes: Uint8Array): SourceRasterKind | undefined {
  const ascii = Buffer.from(bytes).toString("ascii");
  if (hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) {
    return "png";
  }
  if (hasPrefix(bytes, [255, 216, 255])) {
    return "jpeg";
  }
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return "gif";
  }
  if (ascii.startsWith("BM")) {
    return "bmp";
  }
  if (hasPrefix(bytes, [73, 73, 42, 0]) || hasPrefix(bytes, [77, 77, 0, 42])) {
    return "tiff";
  }
  if (
    (ascii.startsWith("P3") || ascii.startsWith("P6")) &&
    /\s/.test(ascii[2] ?? "")
  ) {
    return "ppm";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "webp";
  }
  if (hasPrefix(bytes, [0, 0, 1, 0])) {
    return "ico";
  }
  const isoKind = detectIsoImageKind(bytes);
  if (isoKind) {
    return isoKind;
  }
  return undefined;
}

function detectIsoImageKind(bytes: Uint8Array): "avif" | "heif" | undefined {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 12 || buffer.toString("ascii", 4, 8) !== "ftyp") {
    return undefined;
  }
  const size32 = buffer.readUInt32BE(0);
  let majorBrandOffset = 8;
  let compatibleBrandsOffset = 16;
  let declaredSize = size32;
  if (size32 === 1) {
    if (buffer.length < 20) {
      return undefined;
    }
    const extendedSize = buffer.readBigUInt64BE(8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }
    declaredSize = Number(extendedSize);
    majorBrandOffset = 16;
    compatibleBrandsOffset = 24;
  }
  if (
    declaredSize !== 0 &&
    (declaredSize < compatibleBrandsOffset ||
      majorBrandOffset + 4 > declaredSize)
  ) {
    return undefined;
  }
  const availableEnd = Math.min(
    declaredSize === 0 ? buffer.length : declaredSize,
    buffer.length,
  );
  if (majorBrandOffset + 4 > availableEnd) {
    return undefined;
  }
  const brands = [
    buffer.toString("ascii", majorBrandOffset, majorBrandOffset + 4),
  ];
  for (
    let offset = compatibleBrandsOffset;
    offset + 4 <= availableEnd;
    offset += 4
  ) {
    brands.push(buffer.toString("ascii", offset, offset + 4));
  }
  if (brands.some((brand) => ["avif", "avio", "avis"].includes(brand))) {
    return "avif";
  }
  return brands.some((brand) =>
    ["heic", "heix", "hevc", "hevm", "hevs", "hevx", "mif1", "msf1"].includes(
      brand,
    ),
  )
    ? "heif"
    : undefined;
}

function expectedRasterFromExtension(
  path: string,
): SourceRasterKind | "unsupported" | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "png";
    case ".jpg":
    case ".jpeg":
      return "jpeg";
    case ".gif":
      return "gif";
    case ".bmp":
      return "bmp";
    case ".tif":
    case ".tiff":
      return "tiff";
    case ".ppm":
      return "ppm";
    case ".webp":
      return "webp";
    case ".avif":
      return "avif";
    case ".heic":
    case ".heif":
      return "heif";
    case ".ico":
      return "ico";
    case ".j2k":
    case ".jp2":
    case ".jxl":
      return "unsupported";
    default:
      return undefined;
  }
}

function validateModelOutput(
  output: RasterClaimInspectionOutput,
  assetCount: number,
  forbiddenClaimIndices: number[],
): RasterClaimInspectionOutput {
  if (
    !output ||
    !/^[a-f0-9]{64}$/.test(output.modelDigest) ||
    !Array.isArray(output.results) ||
    output.results.length !== assetCount
  ) {
    throw new RasterClaimInspectionError(
      "MODEL_RESPONSE_INVALID",
      "Raster claim response did not bind every asset",
    );
  }
  const normalizedResults = output.results.map((result, resultIndex) => {
    if (
      !result ||
      result.assetIndex !== resultIndex ||
      !["CLEAR", "MATCH", "UNSUPPORTED", "UNVERIFIED"].includes(
        result.status,
      ) ||
      !Array.isArray(result.matchedForbiddenClaimIndices)
    ) {
      throw new RasterClaimInspectionError(
        "MODEL_RESPONSE_INVALID",
        "Raster claim response has an invalid ordered result",
      );
    }
    const indices = result.matchedForbiddenClaimIndices;
    if (
      new Set(indices).size !== indices.length ||
      !indices.every(
        (index, position) =>
          Number.isInteger(index) &&
          forbiddenClaimIndices.includes(index) &&
          (position === 0 || indices[position - 1]! < index),
      ) ||
      (result.status === "MATCH" ? indices.length === 0 : indices.length > 0)
    ) {
      throw new RasterClaimInspectionError(
        "MODEL_RESPONSE_INVALID",
        "Raster claim response has invalid match indices",
      );
    }
    return {
      assetIndex: resultIndex,
      status: result.status,
      matchedForbiddenClaimIndices: indices.slice(),
    };
  });
  return { modelDigest: output.modelDigest, results: normalizedResults };
}

function createVisualReceipt(
  request: RasterClaimInspectionRequest,
  startedAt: string,
  shape: ReceiptShape,
): RasterClaimReceipt {
  const completedAt = new Date().toISOString();
  const assetDigests = shape.assets.map((asset) => asset.sha256);
  const modelInputDigests = shape.assets.map((asset) => asset.imageSha256);
  const aggregateBytes = totalAssetBytes(shape.assets);
  const forbiddenClaimIndices = request.assignment.contract.forbiddenClaims.map(
    (_, index) => index,
  );
  const claimSetDigest = sha256(
    canonicalJson(request.assignment.contract.forbiddenClaims),
  );
  const approvedFactSetDigest = sha256(
    canonicalJson(
      request.assignment.contract.approvedFacts.map((fact) => fact.statement),
    ),
  );
  const renderedInputDigest = renderedRasterInputDigest(request.pages);
  const workspaceAssetCount = shape.assets.filter(
    (asset) => asset.source === "workspace",
  ).length;
  const renderedAssetCount = shape.assets.length - workspaceAssetCount;
  return {
    ...createReceiptBase({
      runId: request.runId,
      revisionHash: request.revisionHash,
      status: shape.status,
      startedAt,
      completedAt,
      input: {
        revisionHash: request.revisionHash,
        claimSetDigest,
        approvedFactSetDigest,
        renderedInputDigest,
        forbiddenClaimIndices,
        assetDigests,
        modelInputDigests,
        aggregateBytes,
      },
      output: {
        status: shape.status,
        matches: shape.matches,
        unsupportedAssetIndices: shape.unsupportedAssetIndices,
        unverifiedAssetIndices: shape.unverifiedAssetIndices,
        ...(shape.modelDigest ? { modelDigest: shape.modelDigest } : {}),
        ...(shape.errorCode ? { errorCode: shape.errorCode } : {}),
      },
    }),
    kind: "visual-claim",
    provider: shape.provider,
    traceProvider: "braintrust",
    traceId: request.trace.traceId,
    claimSetDigest,
    approvedFactSetDigest,
    renderedInputDigest,
    forbiddenClaimIndices,
    assetCount: shape.assets.length,
    workspaceAssetCount,
    renderedAssetCount,
    aggregateBytes,
    assetDigests,
    modelInputDigests,
    matches: shape.matches,
    unsupportedAssetIndices: shape.unsupportedAssetIndices,
    unverifiedAssetIndices: shape.unverifiedAssetIndices,
    ...(shape.modelDigest ? { modelDigest: shape.modelDigest } : {}),
    ...(shape.errorCode ? { errorCode: shape.errorCode } : {}),
  };
}

function renderedRasterInputDigest(pages: InspectedPage[]): string {
  return digestJson(
    pages
      .map((page) => ({
        path: page.path,
        screenshotSha256s: (page.screenshotBase64s ?? []).map((encoded) =>
          sha256(Buffer.from(encoded, "base64")),
        ),
      }))
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.path, "utf8"),
          Buffer.from(right.path, "utf8"),
        ),
      ),
  );
}

function totalAssetBytes(assets: CollectedAsset[]): number {
  return assets.reduce((total, asset) => total + asset.sourceSizeBytes, 0);
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function throwIfAborted(signal?: AbortSignal, error?: unknown): void {
  if (
    signal?.aborted ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    throw signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("Operation aborted", "AbortError");
  }
}
