import { createHash, createHmac } from "node:crypto";

import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { opaqueAlias, sessionBinding } from "../lib/server/aliases";
import { customerProjectionRegistry } from "../lib/server/projection-registry";
import {
  CustomerWipFrameStore,
  customerWipFrameStore,
  handleCustomerWipFrame,
  handleCustomerWipMetadata,
  handleInternalWipFrameIngest,
} from "../lib/server/wip-raster";
import {
  TEST_ALIAS_SECRET,
  TEST_INTERNAL_TOKEN,
  TEST_PROJECT_ID,
  TEST_SESSION,
  TEST_WIP_ATTESTATION_SECRET,
  TEST_WIP_POLICY_DIGEST,
  customerAuth,
} from "./bff-fixtures";

const RUN_ID = "run-customer-wip-1";
const CANDIDATE_ID = "candidate-customer-wip-1";
const CONTRACT_VERSION = 3;

describe("customer raster WIP gateway", () => {
  beforeEach(() => {
    process.env.BUILDLABS_DASHBOARD_ALIAS_SECRET = TEST_ALIAS_SECRET;
    process.env.BUILDLABS_DASHBOARD_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;
    process.env.BUILDLABS_DASHBOARD_WIP_POLICY_DIGEST = TEST_WIP_POLICY_DIGEST;
    process.env.BUILDLABS_DASHBOARD_WIP_ATTESTATION_SECRET =
      TEST_WIP_ATTESTATION_SECRET;
    customerWipFrameStore.clear();
    customerProjectionRegistry.clear();
  });

  it("requires server authentication and rejects arbitrary payload shapes", async () => {
    const png = await fixturePng();
    const body = frameBody(png);
    const unauthorized = await handleInternalWipFrameIngest(
      new Request(
        "https://dashboard.buildlabs.test/v1/internal/customer-wip/frames",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
    const unsafeShape = await handleInternalWipFrameIngest(
      internalFrameRequest({ ...body, providerId: "must-not-be-accepted" }),
    );
    const wrongPolicy = await handleInternalWipFrameIngest(
      internalFrameRequest({
        ...body,
        sanitizationPolicyDigest: "c".repeat(64),
      }),
    );
    const forgedReceipt = await handleInternalWipFrameIngest(
      internalFrameRequest({
        ...body,
        sanitizationReceipt: "d".repeat(64),
      }),
    );
    const html = await handleInternalWipFrameIngest(
      internalFrameRequest({
        ...body,
        pngBase64: Buffer.from("<html>not a raster</html>").toString("base64"),
      }),
    );

    expect(unauthorized.status).toBe(401);
    expect(unsafeShape.status).toBe(400);
    expect(wrongPolicy.status).toBe(403);
    expect(forgedReceipt.status).toBe(403);
    expect(html.status).toBe(403);
  });

  it("re-encodes metadata-free PNG and serves it only through the exact fence", async () => {
    const input = await fixturePng();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const ingest = await handleInternalWipFrameIngest(
      internalFrameRequest(frameBody(input)),
    );
    const receipt = (await ingest.json()) as {
      frameId: string;
      expiresAt: string;
    };
    const auth = customerAuth();
    const builderAlias = registerFence(auth.projectAlias);
    const metadataResponse = handleCustomerWipMetadata({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/builders/${builderAlias}/wip`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      builderAlias,
    });
    const frameMetadata = (await metadataResponse.json()) as {
      latestFrameId: string;
      width: number;
      height: number;
    };
    const response = handleCustomerWipFrame({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/builders/${builderAlias}/wip/frames/${frameMetadata.latestFrameId}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      builderAlias,
      frameId: frameMetadata.latestFrameId,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const outputMetadata = await sharp(bytes).metadata();
    const topPixel = await sharp(bytes)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();

    expect(ingest.status).toBe(202);
    expect(Date.parse(receipt.expiresAt) - Date.now()).toBeLessThanOrEqual(
      60_000,
    );
    expect(metadataResponse.status).toBe(200);
    expect(frameMetadata).toMatchObject({ width: 400, height: 640 });
    expect(frameMetadata.latestFrameId).not.toBe(receipt.frameId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-buildlabs-content-status")).toBe(
      "unverified-wip",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(outputMetadata.format).toBe("png");
    expect(outputMetadata.exif).toBeUndefined();
    expect([...topPixel]).not.toEqual([19, 140, 170]);
  });

  it("destroys high-frequency and text-like detail before customer rendering", async () => {
    const input = await detailDenseFixturePng();
    const ingest = await handleInternalWipFrameIngest(
      internalFrameRequest(frameBody(input)),
    );
    const auth = customerAuth();
    const builderAlias = registerFence(auth.projectAlias);
    const metadataResponse = handleCustomerWipMetadata({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/builders/${builderAlias}/wip`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      builderAlias,
    });
    const metadata = (await metadataResponse.json()) as {
      latestFrameId: string;
    };
    const frameResponse = handleCustomerWipFrame({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/builders/${builderAlias}/wip/frames/${metadata.latestFrameId}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      builderAlias,
      frameId: metadata.latestFrameId,
    });
    const output = Buffer.from(await frameResponse.arrayBuffer());

    expect(ingest.status).toBe(202);
    expect(metadataResponse.status).toBe(200);
    expect(frameResponse.status).toBe(200);
    expect(await horizontalTransitionRatio(input, 64)).toBeGreaterThan(0.8);
    expect(await horizontalTransitionRatio(output, 64)).toBeLessThan(0.08);
  });

  it("rejects forged frame, candidate, contract, and session coordinates", async () => {
    const ingest = await handleInternalWipFrameIngest(
      internalFrameRequest(frameBody(await fixturePng())),
    );
    const { frameId: sourceFrameId } = (await ingest.json()) as {
      frameId: string;
    };
    const frameId = opaqueAlias(
      "frm",
      `${sourceFrameId}\0${sessionBinding(TEST_SESSION, TEST_ALIAS_SECRET)}`,
      TEST_ALIAS_SECRET,
    );
    const auth = customerAuth();
    const builderAlias = registerFence(auth.projectAlias);
    const baseRequest = new Request(
      `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
      { headers: { cookie: auth.cookie } },
    );

    const forgedFrame = handleCustomerWipFrame({
      request: baseRequest.clone(),
      projectAlias: auth.projectAlias,
      builderAlias,
      frameId: opaqueAlias("frm", "forged-frame", TEST_ALIAS_SECRET),
    });

    customerProjectionRegistry.clear();
    const wrongCandidateBuilder = opaqueAlias(
      "bld",
      `${RUN_ID}\0other-candidate`,
      TEST_ALIAS_SECRET,
    );
    customerProjectionRegistry.replaceProjectFences(
      auth.projectAlias,
      sessionBinding(TEST_SESSION, TEST_ALIAS_SECRET),
      [
        {
          projectAlias: auth.projectAlias,
          internalProjectId: TEST_PROJECT_ID,
          builderAlias: wrongCandidateBuilder,
          runId: RUN_ID,
          candidateId: "other-candidate",
          contractVersion: CONTRACT_VERSION,
          sessionBinding: sessionBinding(TEST_SESSION, TEST_ALIAS_SECRET),
          registeredAt: Date.now(),
        },
      ],
    );
    const forgedCandidate = handleCustomerWipFrame({
      request: baseRequest.clone(),
      projectAlias: auth.projectAlias,
      builderAlias: wrongCandidateBuilder,
      frameId,
    });

    customerProjectionRegistry.clear();
    const wrongContractBuilder = registerFence(
      auth.projectAlias,
      CONTRACT_VERSION + 1,
    );
    const forgedContract = handleCustomerWipFrame({
      request: baseRequest.clone(),
      projectAlias: auth.projectAlias,
      builderAlias: wrongContractBuilder,
      frameId,
    });

    const otherSession = customerAuth("session.v1.other-dashboard-session");
    const forgedSession = handleCustomerWipFrame({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${otherSession.projectAlias}`,
        { headers: { cookie: otherSession.cookie } },
      ),
      projectAlias: otherSession.projectAlias,
      builderAlias: wrongContractBuilder,
      frameId,
    });

    expect(forgedFrame.status).toBe(404);
    expect(forgedCandidate.status).toBe(404);
    expect(forgedContract.status).toBe(404);
    expect(forgedSession.status).toBe(404);
  });

  it("discards prior pixels and reports blocked after a sanitizer failure", async () => {
    const accepted = await handleInternalWipFrameIngest(
      internalFrameRequest(frameBody(await fixturePng())),
    );
    const auth = customerAuth();
    const builderAlias = registerFence(auth.projectAlias);
    const metadataRequest = new Request(
      `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/builders/${builderAlias}/wip`,
      { headers: { cookie: auth.cookie } },
    );
    const before = handleCustomerWipMetadata({
      request: metadataRequest.clone(),
      projectAlias: auth.projectAlias,
      builderAlias,
    });
    const { latestFrameId } = (await before.json()) as {
      latestFrameId: string;
    };
    const invalidPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("invalid-png-body"),
    ]);
    const rejected = await handleInternalWipFrameIngest(
      internalFrameRequest(frameBody(invalidPng)),
    );
    const after = handleCustomerWipMetadata({
      request: metadataRequest.clone(),
      projectAlias: auth.projectAlias,
      builderAlias,
    });
    const staleFrame = handleCustomerWipFrame({
      request: metadataRequest,
      projectAlias: auth.projectAlias,
      builderAlias,
      frameId: latestFrameId,
    });

    expect(accepted.status).toBe(202);
    expect(before.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({
      state: "blocked",
      customerRenderable: false,
      latestFrameId: null,
      capturedAt: null,
      width: null,
      height: null,
      expiresAt: null,
    });
    expect(staleFrame.status).toBe(404);
  });

  it("expires raster bytes instead of retaining an unrestricted artifact", () => {
    const store = new CustomerWipFrameStore();
    const now = Date.now();
    const fence = {
      projectAlias: opaqueAlias("prj", TEST_PROJECT_ID, TEST_ALIAS_SECRET),
      internalProjectId: TEST_PROJECT_ID,
      builderAlias: opaqueAlias(
        "bld",
        `${RUN_ID}\0${CANDIDATE_ID}`,
        TEST_ALIAS_SECRET,
      ),
      runId: RUN_ID,
      candidateId: CANDIDATE_ID,
      contractVersion: CONTRACT_VERSION,
      sessionBinding: sessionBinding(TEST_SESSION, TEST_ALIAS_SECRET),
      registeredAt: now,
    };
    store.put(
      {
        projectId: TEST_PROJECT_ID,
        runId: RUN_ID,
        candidateId: CANDIDATE_ID,
        contractVersion: CONTRACT_VERSION,
        frameId: opaqueAlias("frm", "expiring-frame", TEST_ALIAS_SECRET),
        capturedAt: new Date(now).toISOString(),
        expiresAtMs: now + 10,
        width: 640,
        height: 400,
        png: Buffer.from([1, 2, 3]),
      },
      now,
    );

    expect(store.get(fence, undefined, now + 11)).toBeUndefined();
  });

  it("rate-limits changed frames while keeping exact ingest replay idempotent", async () => {
    const capturedAt = new Date().toISOString();
    const firstBody = frameBody(await fixturePng(), capturedAt);
    const first = await handleInternalWipFrameIngest(
      internalFrameRequest(firstBody),
    );
    const replay = await handleInternalWipFrameIngest(
      internalFrameRequest(firstBody),
    );
    const changed = await handleInternalWipFrameIngest(
      internalFrameRequest(
        frameBody(await fixturePng({ r: 180, g: 40, b: 60 }), capturedAt),
      ),
    );

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(await first.json());
    expect(changed.status).toBe(429);
  });
});

async function fixturePng(color = { r: 19, g: 140, b: 170 }): Promise<Buffer> {
  return sharp({
    create: {
      width: 640,
      height: 400,
      channels: 4,
      background: { ...color, alpha: 1 },
    },
  })
    .withMetadata({ orientation: 6 })
    .png()
    .toBuffer();
}

async function detailDenseFixturePng(): Promise<Buffer> {
  const width = 640;
  const height = 400;
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x % 2 === 0 ? 0 : 255;
      const offset = (y * width + x) * channels;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
    }
  }
  const textOverlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="80" y="140" width="480" height="90" fill="#ffffff"/><text x="100" y="197" fill="#000000" font-family="Arial, sans-serif" font-size="38" font-weight="700">CUSTOMER DETAIL 4827</text></svg>`,
    "utf8",
  );
  return sharp(pixels, { raw: { width, height, channels } })
    .composite([{ input: textOverlay, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

async function horizontalTransitionRatio(
  png: Buffer,
  cropTop: number,
): Promise<number> {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transitions = 0;
  let comparisons = 0;
  for (let y = cropTop; y < info.height; y += 1) {
    for (let x = 1; x < info.width; x += 1) {
      const left = (y * info.width + x - 1) * info.channels;
      const right = left + info.channels;
      const channelDelta =
        Math.abs(data[left]! - data[right]!) +
        Math.abs(data[left + 1]! - data[right + 1]!) +
        Math.abs(data[left + 2]! - data[right + 2]!);
      if (channelDelta > 48) transitions += 1;
      comparisons += 1;
    }
  }
  return transitions / comparisons;
}

function frameBody(
  png: Buffer,
  capturedAt = new Date().toISOString(),
): Record<string, unknown> {
  const sanitizedPngDigest = createHash("sha256").update(png).digest("hex");
  const sanitizationReceipt = createHmac("sha256", TEST_WIP_ATTESTATION_SECRET)
    .update(
      [
        "buildlabs.dashboard.wip-sanitization.v1",
        TEST_PROJECT_ID,
        RUN_ID,
        CANDIDATE_ID,
        String(CONTRACT_VERSION),
        "Builder 1",
        capturedAt,
        TEST_WIP_POLICY_DIGEST,
        sanitizedPngDigest,
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
  return {
    projectId: TEST_PROJECT_ID,
    runId: RUN_ID,
    candidateId: CANDIDATE_ID,
    contractVersion: CONTRACT_VERSION,
    builderDisplayName: "Builder 1",
    capturedAt,
    sanitizationPolicyDigest: TEST_WIP_POLICY_DIGEST,
    sanitizedPngDigest,
    sanitizationReceipt,
    pngBase64: png.toString("base64"),
  };
}

function internalFrameRequest(body: unknown): Request {
  return new Request(
    "https://dashboard.buildlabs.test/v1/internal/customer-wip/frames",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_INTERNAL_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function registerFence(
  projectAlias: string,
  contractVersion = CONTRACT_VERSION,
): string {
  const builderAlias = opaqueAlias(
    "bld",
    `${RUN_ID}\0${CANDIDATE_ID}`,
    TEST_ALIAS_SECRET,
  );
  const binding = sessionBinding(TEST_SESSION, TEST_ALIAS_SECRET);
  customerProjectionRegistry.replaceProjectFences(projectAlias, binding, [
    {
      projectAlias,
      internalProjectId: TEST_PROJECT_ID,
      builderAlias,
      runId: RUN_ID,
      candidateId: CANDIDATE_ID,
      contractVersion,
      sessionBinding: binding,
      registeredAt: Date.now(),
    },
  ]);
  return builderAlias;
}
