import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, digestJson, sha256 } from "../../lib/canonical-json.js";

export const DAYTONA_SNAPSHOT_ATTESTATION_SCHEMA =
  "buildlabs.daytona.snapshot-attestation.v1";

export const DAYTONA_PINNED_SNAPSHOT_INPUTS = {
  sandboxClass: "daytona-large",
  baseImage: "docker:28.3.3-dind",
  alpinePackages: [
    "bash",
    "build-base",
    "ca-certificates",
    "chromium",
    "coreutils",
    "curl",
    "findutils",
    "git",
    "grep",
    "jq",
    "nodejs",
    "npm",
    "openssh-client",
    "procps",
    "python3",
    "py3-pip",
    "tar",
  ],
  playwrightCoreVersion: "1.61.1",
  resources: {
    cpu: 4,
    memoryGiB: 8,
    diskGiB: 10,
  },
} as const;

export interface DaytonaSnapshotIdentity {
  id: string;
  name: string;
  state: "active";
  imageName?: string;
  ref?: string;
  sandboxClass?: string;
  regionIds: string[];
  resources: {
    cpu: number;
    memoryGiB: number;
    diskGiB: number;
  };
  buildInfo: {
    snapshotRef: string;
    dockerfileSha256: string;
    contextHashesSha256: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface DaytonaSnapshotValidation {
  validatedAt: string;
  chromiumVersion: string;
  dockerServerVersion: string;
  dindReady: true;
  renderedChromiumProof: true;
  staleDomRaceBlocked: true;
  signedPreviewIngress: true;
  resourceMetrics: {
    latest: true;
    historical: true;
  };
  networkBlockAll: {
    directIpEgressBlocked: true;
    registryEgressBlocked: true;
    loopbackPreserved: true;
    reappliedAfterRestart: true;
  };
}

export interface DaytonaSnapshotAttestationPayload {
  schema: typeof DAYTONA_SNAPSHOT_ATTESTATION_SCHEMA;
  provisionerSourceSha256: string;
  imageInputs: typeof DAYTONA_PINNED_SNAPSHOT_INPUTS;
  snapshot: DaytonaSnapshotIdentity;
  validation: DaytonaSnapshotValidation;
}

export interface DaytonaSnapshotAttestation {
  payload: DaytonaSnapshotAttestationPayload;
  payloadSha256: string;
}

export interface DaytonaSnapshotRuntimeObservation {
  snapshotId: string;
  snapshotName: string;
  target: string;
  resources: {
    cpu: number;
    memoryGiB: number;
    diskGiB: number;
  };
  chromiumVersion: string;
  dockerServerVersion: string;
}

export function createDaytonaSnapshotAttestation(
  payload: DaytonaSnapshotAttestationPayload,
): DaytonaSnapshotAttestation {
  assertDaytonaSnapshotAttestationPayload(payload);
  return {
    payload,
    payloadSha256: digestJson(payload),
  };
}

export async function readDaytonaSnapshotAttestation(
  path: string,
): Promise<DaytonaSnapshotAttestation> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      "Daytona snapshot attestation is unavailable or malformed",
      {
        cause: error,
      },
    );
  }
  assertDaytonaSnapshotAttestation(parsed);
  return parsed;
}

export async function writeDaytonaSnapshotAttestation(
  path: string,
  attestation: DaytonaSnapshotAttestation,
): Promise<void> {
  assertDaytonaSnapshotAttestation(attestation);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${canonicalJson(attestation)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export function assertDaytonaSnapshotAttestation(
  value: unknown,
): asserts value is DaytonaSnapshotAttestation {
  if (!isRecord(value)) {
    throw new Error("Daytona snapshot attestation must be an object");
  }
  const payload = value.payload;
  const payloadSha256 = value.payloadSha256;
  assertDaytonaSnapshotAttestationPayload(payload);
  if (
    typeof payloadSha256 !== "string" ||
    !isSha256(payloadSha256) ||
    payloadSha256 !== digestJson(payload)
  ) {
    throw new Error("Daytona snapshot attestation digest does not match");
  }
}

export function assertDaytonaSnapshotRuntime(
  attestation: DaytonaSnapshotAttestation,
  observation: DaytonaSnapshotRuntimeObservation,
  expectedSnapshotName: string,
  expectedTarget?: string,
): void {
  assertDaytonaSnapshotAttestation(attestation);
  const expected = attestation.payload.snapshot;
  if (
    expected.name !== expectedSnapshotName ||
    observation.snapshotName !== expected.name ||
    observation.snapshotId !== expected.id
  ) {
    throw new Error("Daytona snapshot identity drifted from its attestation");
  }
  if (expectedTarget && observation.target !== expectedTarget) {
    throw new Error(
      "Daytona snapshot target drifted from its acquisition policy",
    );
  }
  if (
    observation.resources.cpu !== expected.resources.cpu ||
    observation.resources.memoryGiB !== expected.resources.memoryGiB ||
    observation.resources.diskGiB !== expected.resources.diskGiB
  ) {
    throw new Error(
      "Daytona snapshot resources drifted from their attestation",
    );
  }
  if (
    observation.chromiumVersion !==
      attestation.payload.validation.chromiumVersion ||
    observation.dockerServerVersion !==
      attestation.payload.validation.dockerServerVersion
  ) {
    throw new Error("Daytona snapshot runtime drifted from its attestation");
  }
}

export function assertFreshDaytonaSnapshotAttestation(
  attestation: DaytonaSnapshotAttestation,
  now: Date = new Date(),
  maxAgeMilliseconds = 7 * 24 * 60 * 60 * 1_000,
): void {
  assertDaytonaSnapshotAttestation(attestation);
  if (
    !Number.isInteger(maxAgeMilliseconds) ||
    maxAgeMilliseconds < 60_000 ||
    now.getTime() - Date.parse(attestation.payload.validation.validatedAt) >
      maxAgeMilliseconds ||
    Date.parse(attestation.payload.validation.validatedAt) >
      now.getTime() + 60_000
  ) {
    throw new Error("Daytona snapshot attestation validation is stale");
  }
}

export function daytonaProvisionerSourceDigest(source: Uint8Array): string {
  return sha256(source);
}

export function assertDaytonaProvisionerSource(
  attestation: DaytonaSnapshotAttestation,
  source: Uint8Array,
): void {
  assertDaytonaSnapshotAttestation(attestation);
  if (
    daytonaProvisionerSourceDigest(source) !==
    attestation.payload.provisionerSourceSha256
  ) {
    throw new Error(
      "Daytona snapshot provisioner source drifted from its attestation",
    );
  }
}

function assertDaytonaSnapshotAttestationPayload(
  value: unknown,
): asserts value is DaytonaSnapshotAttestationPayload {
  if (!isRecord(value)) {
    throw new Error("Daytona snapshot attestation payload must be an object");
  }
  if (value.schema !== DAYTONA_SNAPSHOT_ATTESTATION_SCHEMA) {
    throw new Error("Daytona snapshot attestation schema is unsupported");
  }
  if (
    typeof value.provisionerSourceSha256 !== "string" ||
    !isSha256(value.provisionerSourceSha256)
  ) {
    throw new Error("Daytona snapshot provisioner digest is invalid");
  }
  if (
    canonicalJson(value.imageInputs) !==
    canonicalJson(DAYTONA_PINNED_SNAPSHOT_INPUTS)
  ) {
    throw new Error(
      "Daytona snapshot image inputs drifted from controller policy",
    );
  }
  assertSnapshotIdentity(value.snapshot);
  if (
    canonicalJson(value.snapshot.resources) !==
    canonicalJson(DAYTONA_PINNED_SNAPSHOT_INPUTS.resources)
  ) {
    throw new Error(
      "Daytona snapshot resources drifted from pinned image inputs",
    );
  }
  assertSnapshotValidation(value.validation);
}

function assertSnapshotIdentity(
  value: unknown,
): asserts value is DaytonaSnapshotIdentity {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    value.state !== "active" ||
    !Array.isArray(value.regionIds) ||
    !value.regionIds.every(isNonEmptyString) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    !isRecord(value.resources) ||
    !isPositiveNumber(value.resources.cpu) ||
    !isPositiveNumber(value.resources.memoryGiB) ||
    !isPositiveNumber(value.resources.diskGiB) ||
    !isRecord(value.buildInfo) ||
    !isNonEmptyString(value.buildInfo.snapshotRef) ||
    typeof value.buildInfo.dockerfileSha256 !== "string" ||
    !isSha256(value.buildInfo.dockerfileSha256) ||
    typeof value.buildInfo.contextHashesSha256 !== "string" ||
    !isSha256(value.buildInfo.contextHashesSha256)
  ) {
    throw new Error("Daytona snapshot identity attestation is invalid");
  }
  if (value.imageName !== undefined && typeof value.imageName !== "string") {
    throw new Error("Daytona snapshot image identity is invalid");
  }
  if (
    (value.ref !== undefined && typeof value.ref !== "string") ||
    (value.sandboxClass !== undefined && typeof value.sandboxClass !== "string")
  ) {
    throw new Error("Daytona snapshot platform identity is invalid");
  }
}

function assertSnapshotValidation(
  value: unknown,
): asserts value is DaytonaSnapshotValidation {
  if (
    !isRecord(value) ||
    !isIsoDate(value.validatedAt) ||
    !isNonEmptyString(value.chromiumVersion) ||
    !isNonEmptyString(value.dockerServerVersion) ||
    value.dindReady !== true ||
    value.renderedChromiumProof !== true ||
    value.staleDomRaceBlocked !== true ||
    value.signedPreviewIngress !== true ||
    !isRecord(value.resourceMetrics) ||
    value.resourceMetrics.latest !== true ||
    value.resourceMetrics.historical !== true ||
    !isRecord(value.networkBlockAll) ||
    value.networkBlockAll.directIpEgressBlocked !== true ||
    value.networkBlockAll.registryEgressBlocked !== true ||
    value.networkBlockAll.loopbackPreserved !== true ||
    value.networkBlockAll.reappliedAfterRestart !== true
  ) {
    throw new Error("Daytona snapshot validation attestation is incomplete");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
