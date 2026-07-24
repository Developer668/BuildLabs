import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectRasterClaims } from "../src/application/raster-claim-inspector.js";
import { RasterClaimReceiptSchema } from "../src/domain/evidence.js";
import { digestJson, sha256 } from "../src/lib/canonical-json.js";
import type {
  InspectedPage,
  ModelPort,
  RasterClaimInspectionInput,
  RasterClaimInspectionOutput,
  TraceSpan,
} from "../src/ports/index.js";
import { assignment } from "./fixtures.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const STATIC_WEBP = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=",
  "base64",
).subarray(0, 42);
const MODEL_DIGEST = sha256("test-fireworks-vision-model");

describe("raster claim inspector", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(
      workspaces
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function createWorkspace(): Promise<string> {
    const directory = await mkdtemp(
      join(tmpdir(), "buildlabs-raster-claims-"),
    );
    workspaces.push(directory);
    return directory;
  }

  it("inspects zero-claim contracts, persists an empty policy binding, and keeps traces content-free", async () => {
    const workspaceDirectory = await createWorkspace();
    await writeFile(join(workspaceDirectory, "secret-campaign.png"), PNG);
    const input = assignment("zero-raster-claims", (value) => {
      value.contract.forbiddenClaims = [];
    });
    const calls: RasterClaimInspectionInput[] = [];
    const trace = new RecordingSpan();
    const model = inspectionModel((request) => {
      calls.push(request);
      return Promise.resolve(clearOutput(request));
    });

    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "a".repeat(64),
      assignment: input,
      workspaceDirectory,
      pages: [renderedPage()],
      model,
      trace,
    });

    expect(RasterClaimReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({
      status: "PASS",
      provider: "fireworks",
      forbiddenClaimIndices: [],
      workspaceAssetCount: 1,
      renderedAssetCount: 1,
      assetCount: 2,
      matches: [],
      unsupportedAssetIndices: [],
      unverifiedAssetIndices: [],
    });
    expect(receipt.assetDigests).toEqual([sha256(PNG), sha256(PNG)]);
    expect(receipt.renderedInputDigest).toBe(
      digestJson([{ path: "/", screenshotSha256s: [sha256(PNG)] }]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.forbiddenClaims).toEqual([]);
    expect(calls[0]?.approvedFacts).toEqual(
      input.contract.approvedFacts.map((fact) => fact.statement),
    );

    const serializedTrace = JSON.stringify(trace.records);
    expect(serializedTrace).not.toContain("secret-campaign.png");
    expect(serializedTrace).not.toContain(
      input.contract.approvedFacts[0]!.statement,
    );
    expect(serializedTrace).not.toContain(PNG.toString("base64"));
  });

  it("fails with digest-bound evidence when visible text matches a forbidden claim", async () => {
    const workspaceDirectory = await createWorkspace();
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "b".repeat(64),
      assignment: assignment("matched-raster-claim"),
      workspaceDirectory,
      pages: [renderedPage()],
      model: inspectionModel((request) =>
        Promise.resolve({
          modelDigest: MODEL_DIGEST,
          results: request.assets.map((asset) => ({
            assetIndex: asset.index,
            status: "MATCH" as const,
            matchedForbiddenClaimIndices: [0],
          })),
        }),
      ),
      trace: new RecordingSpan(),
    });

    expect(receipt.status).toBe("FAIL");
    expect(receipt.matches).toEqual([
      {
        assetIndex: 0,
        assetSha256: sha256(PNG),
        forbiddenClaimIndices: [0],
      },
    ]);
    expect(RasterClaimReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it("fails on an unsupported business assertion even when forbiddenClaims is empty", async () => {
    const workspaceDirectory = await createWorkspace();
    const input = assignment("unsupported-raster-claim", (value) => {
      value.contract.forbiddenClaims = [];
    });
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "c".repeat(64),
      assignment: input,
      workspaceDirectory,
      pages: [renderedPage()],
      model: statusModel("UNSUPPORTED"),
      trace: new RecordingSpan(),
    });

    expect(receipt).toMatchObject({
      status: "FAIL",
      forbiddenClaimIndices: [],
      unsupportedAssetIndices: [0],
      matches: [],
    });
    expect(RasterClaimReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it("turns malformed model results into bounded error evidence", async () => {
    const workspaceDirectory = await createWorkspace();
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "d".repeat(64),
      assignment: assignment("malformed-raster-model"),
      workspaceDirectory,
      pages: [renderedPage()],
      model: inspectionModel(() =>
        Promise.resolve({
          modelDigest: MODEL_DIGEST,
          results: [
            {
              assetIndex: 1,
              status: "CLEAR",
              matchedForbiddenClaimIndices: [],
            },
          ],
        }),
      ),
      trace: new RecordingSpan(),
    });

    expect(receipt).toMatchObject({
      status: "ERROR",
      provider: "fireworks",
      errorCode: "model_response_invalid",
      assetCount: 1,
    });
  });

  it("does not place raw provider failures in trace telemetry", async () => {
    const workspaceDirectory = await createWorkspace();
    const trace = new RecordingSpan();
    const providerSentinel =
      "RAW_PROVIDER_RESPONSE_WITH_OCR_AND_PRIVATE_REASONING";
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "e".repeat(64),
      assignment: assignment("private-provider-error"),
      workspaceDirectory,
      pages: [renderedPage()],
      model: inspectionModel(() => Promise.reject(new Error(providerSentinel))),
      trace,
    });

    expect(receipt).toMatchObject({
      status: "ERROR",
      errorCode: "provider_error",
    });
    expect(JSON.stringify(trace.records)).not.toContain(providerSentinel);
  });

  it("batches more than sixteen assets without dropping an input", async () => {
    const workspaceDirectory = await createWorkspace();
    await Promise.all(
      Array.from({ length: 17 }, (_, index) =>
        writeFile(
          join(
            workspaceDirectory,
            `asset-${String(index).padStart(2, "0")}.png`,
          ),
          PNG,
        ),
      ),
    );
    const batchSizes: number[] = [];
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "f".repeat(64),
      assignment: assignment("raster-batches"),
      workspaceDirectory,
      pages: [],
      model: inspectionModel((request) => {
        batchSizes.push(request.assets.length);
        return Promise.resolve(clearOutput(request));
      }),
      trace: new RecordingSpan(),
    });

    expect(batchSizes).toEqual([16, 1]);
    expect(receipt).toMatchObject({
      status: "PASS",
      assetCount: 17,
      workspaceAssetCount: 17,
      renderedAssetCount: 0,
    });
  });

  it("accepts a valid PNG larger than one MiB within the documented request limits", async () => {
    const workspaceDirectory = await createWorkspace();
    const largePng = pngWithAncillaryChunk(1_100_000);
    await writeFile(join(workspaceDirectory, "large.png"), largePng);
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "1".repeat(64),
      assignment: assignment("large-raster"),
      workspaceDirectory,
      pages: [],
      model: statusModel("CLEAR"),
      trace: new RecordingSpan(),
    });

    expect(receipt.status).toBe("PASS");
    expect(receipt.aggregateBytes).toBe(largePng.length);
    expect(receipt.assetDigests).toEqual([sha256(largePng)]);
  });

  it("bounds source raster discovery before invoking Fireworks", async () => {
    const workspaceDirectory = await createWorkspace();
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        writeFile(join(workspaceDirectory, `${index}.png`), PNG),
      ),
    );
    let calls = 0;
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "2".repeat(64),
      assignment: assignment("raster-bound"),
      workspaceDirectory,
      pages: [],
      model: inspectionModel((request) => {
        calls += 1;
        return Promise.resolve(clearOutput(request));
      }),
      trace: new RecordingSpan(),
    });

    expect(calls).toBe(0);
    expect(receipt).toMatchObject({
      status: "ERROR",
      provider: "controller",
      errorCode: "asset_bound_exceeded",
      assetCount: 0,
    });
  });

  it("uses rendered PNG pixels to cover a static WebP source without host decoding", async () => {
    const workspaceDirectory = await createWorkspace();
    await writeFile(join(workspaceDirectory, "hero.webp"), STATIC_WEBP);
    const calls: RasterClaimInspectionInput[] = [];
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "3".repeat(64),
      assignment: assignment("static-webp"),
      workspaceDirectory,
      pages: [renderedPage()],
      model: inspectionModel((request) => {
        calls.push(request);
        return Promise.resolve(clearOutput(request));
      }),
      trace: new RecordingSpan(),
    });

    expect(receipt).toMatchObject({
      status: "PASS",
      workspaceAssetCount: 0,
      renderedAssetCount: 1,
      assetCount: 1,
    });
    expect(calls[0]?.assets[0]?.imageSha256).toBe(sha256(PNG));
    expect(calls[0]?.assets[0]?.imageSha256).not.toBe(sha256(STATIC_WEBP));
  });

  it.each([
    ["VP8X animation flag", animatedWebpWithFlag()],
    ["ANIM chunk", animatedWebpWithChunk("ANIM")],
    ["ANMF chunk", animatedWebpWithChunk("ANMF")],
  ])("rejects animated WebP via its %s", async (_label, bytes) => {
    const workspaceDirectory = await createWorkspace();
    await writeFile(join(workspaceDirectory, "animated.webp"), bytes);
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "4".repeat(64),
      assignment: assignment("animated-webp"),
      workspaceDirectory,
      pages: [],
      model: statusModel("CLEAR"),
      trace: new RecordingSpan(),
    });

    expect(receipt).toMatchObject({
      status: "ERROR",
      errorCode: "multi_frame_asset",
    });
  });

  it.each([
    ["AVIF", "sequence.avif", isoFtyp("avis", ["mif1"])],
    ["HEVC", "sequence.heic", isoFtyp("mif1", ["hevc"])],
    ["L-HEVC", "sequence.heif", isoFtyp("mif1", ["hevs"])],
    ["generic HEIF", "sequence.heif", isoFtyp("msf1", [])],
  ])("rejects a sequence-capable %s brand", async (_label, name, bytes) => {
    const workspaceDirectory = await createWorkspace();
    await writeFile(join(workspaceDirectory, name), bytes);
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "5".repeat(64),
      assignment: assignment("iso-image-sequence"),
      workspaceDirectory,
      pages: [],
      model: statusModel("CLEAR"),
      trace: new RecordingSpan(),
    });

    expect(receipt).toMatchObject({
      status: "ERROR",
      errorCode: "multi_frame_asset",
    });
  });

  it("rejects APNG before a later frame can evade inspection", async () => {
    const workspaceDirectory = await createWorkspace();
    await writeFile(
      join(workspaceDirectory, "later-frame.png"),
      pngWithChunk("acTL", Buffer.alloc(8)),
    );
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "6".repeat(64),
      assignment: assignment("animated-png"),
      workspaceDirectory,
      pages: [],
      model: statusModel("CLEAR"),
      trace: new RecordingSpan(),
    });

    expect(receipt).toMatchObject({
      status: "ERROR",
      errorCode: "multi_frame_asset",
    });
  });

  it("passes an empty workspace without requiring a model capability", async () => {
    const workspaceDirectory = await createWorkspace();
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "7".repeat(64),
      assignment: assignment("no-raster-assets"),
      workspaceDirectory,
      pages: [],
      model: modelWithoutRasterInspection(),
      trace: new RecordingSpan(),
    });

    expect(receipt).toMatchObject({
      status: "PASS",
      provider: "controller",
      assetCount: 0,
    });
    expect(RasterClaimReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it("fails closed when rendered pixels exist but the model capability is missing", async () => {
    const workspaceDirectory = await createWorkspace();
    const receipt = await inspectRasterClaims({
      runId: randomUUID(),
      revisionHash: "8".repeat(64),
      assignment: assignment("missing-raster-capability"),
      workspaceDirectory,
      pages: [renderedPage()],
      model: modelWithoutRasterInspection(),
      trace: new RecordingSpan(),
    });

    expect(receipt).toMatchObject({
      status: "ERROR",
      provider: "controller",
      errorCode: "model_capability_unavailable",
      renderedAssetCount: 1,
    });
  });

  it("propagates cancellation instead of recording a provider result", async () => {
    const workspaceDirectory = await createWorkspace();
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    let calls = 0;

    await expect(
      inspectRasterClaims({
        runId: randomUUID(),
        revisionHash: "9".repeat(64),
        assignment: assignment("cancelled-raster-scan"),
        workspaceDirectory,
        pages: [renderedPage()],
        model: inspectionModel((request) => {
          calls += 1;
          return Promise.resolve(clearOutput(request));
        }),
        trace: new RecordingSpan(),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(calls).toBe(0);
  });
});

class RecordingSpan implements TraceSpan {
  readonly traceId = "trace-raster-claims";
  readonly records: unknown[];

  constructor(records: unknown[] = []) {
    this.records = records;
  }

  log(event: Parameters<TraceSpan["log"]>[0]): void {
    this.records.push({ event });
  }

  async child<T>(
    name: string,
    type: Parameters<TraceSpan["child"]>[1],
    input: unknown,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    this.records.push({ name, type, input });
    return operation(new RecordingSpan(this.records));
  }
}

function inspectionModel(
  inspect: NonNullable<ModelPort["inspectRasterClaims"]>,
): ModelPort {
  return {
    complete: () => Promise.reject(new Error("Unexpected completion")),
    evaluateContract: () =>
      Promise.reject(new Error("Unexpected contract evaluation")),
    inspectRasterClaims: inspect,
    health: () => Promise.resolve(),
  };
}

function modelWithoutRasterInspection(): ModelPort {
  return {
    complete: () => Promise.reject(new Error("Unexpected completion")),
    evaluateContract: () =>
      Promise.reject(new Error("Unexpected contract evaluation")),
    health: () => Promise.resolve(),
  };
}

function statusModel(
  status: RasterClaimInspectionOutput["results"][number]["status"],
): ModelPort {
  return inspectionModel((input) =>
    Promise.resolve({
      modelDigest: MODEL_DIGEST,
      results: input.assets.map((asset) => ({
        assetIndex: asset.index,
        status,
        matchedForbiddenClaimIndices: [],
      })),
    }),
  );
}

function clearOutput(
  input: RasterClaimInspectionInput,
): RasterClaimInspectionOutput {
  return {
    modelDigest: MODEL_DIGEST,
    results: input.assets.map((asset) => ({
      assetIndex: asset.index,
      status: "CLEAR",
      matchedForbiddenClaimIndices: [],
    })),
  };
}

function renderedPage(): InspectedPage {
  return {
    path: "/",
    status: 200,
    visibleText: "24/7 emergency service",
    screenshotBase64s: [PNG.toString("base64")],
  };
}

function pngWithAncillaryChunk(dataBytes: number): Buffer {
  return pngWithChunk("ruSt", Buffer.alloc(dataBytes, 0x61));
}

function pngWithChunk(type: string, data: Buffer): Buffer {
  const iendTypeOffset = PNG.indexOf(Buffer.from("IEND", "ascii"));
  if (iendTypeOffset < 4 || Buffer.byteLength(type, "ascii") !== 4) {
    throw new Error("Invalid PNG test fixture");
  }
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return Buffer.concat([
    PNG.subarray(0, iendTypeOffset - 4),
    chunk,
    PNG.subarray(iendTypeOffset - 4),
  ]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function animatedWebpWithFlag(): Buffer {
  const data = Buffer.alloc(10);
  data[0] = 0x02;
  return webp([riffChunk("VP8X", data)]);
}

function animatedWebpWithChunk(type: "ANIM" | "ANMF"): Buffer {
  return webp([riffChunk(type, Buffer.alloc(type === "ANIM" ? 6 : 16))]);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + (data.length % 2));
  chunk.write(type, 0, 4, "ascii");
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  return chunk;
}

function webp(chunks: Buffer[]): Buffer {
  const payload = Buffer.concat(chunks);
  const bytes = Buffer.alloc(12 + payload.length);
  bytes.write("RIFF", 0, 4, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, 4, "ascii");
  payload.copy(bytes, 12);
  return bytes;
}

function isoFtyp(majorBrand: string, compatibleBrands: string[]): Buffer {
  const bytes = Buffer.alloc(16 + compatibleBrands.length * 4);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write("ftyp", 4, 4, "ascii");
  bytes.write(majorBrand, 8, 4, "ascii");
  for (const [index, brand] of compatibleBrands.entries()) {
    bytes.write(brand, 16 + index * 4, 4, "ascii");
  }
  return bytes;
}
