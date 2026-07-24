import { createHmac, timingSafeEqual } from "node:crypto";

import {
  FireworksModelResourceSchema,
  PatchCheckpointAttestationSchema,
  PatchCheckpointOutcomeSchema,
  PatchCheckpointResultSchema,
  PatchHeldOutComparisonAttestationSchema,
  PatchHeldOutComparisonBodySchema,
  PatchHeldOutComparisonSchema,
  PatchTrainingBundleAttestationSchema,
  PatchTrainingBundleBodySchema,
  PatchTrainingBundleSchema,
  type PatchCheckpointOutcome,
  type PatchCheckpointResult,
  type PatchHeldOutComparison,
  type PatchHeldOutComparisonBody,
  type PatchTrainingBundle,
  type PatchTrainingBundleBody,
} from "../domain/patch-model.js";
import { canonicalJson, digestJson, sha256 } from "./canonical-json.js";

export type PatchCheckpointAttestationKey = string | Uint8Array;

export interface PatchCheckpointAttestationContext {
  role: "base" | "candidate";
  projectScopeId: string;
  dataset: {
    id: string;
    version: string;
    bundleDigest: string;
  };
  modelResource: string;
}

function keyBytes(key: PatchCheckpointAttestationKey): Uint8Array {
  const bytes =
    typeof key === "string" ? Buffer.from(key, "utf8") : new Uint8Array(key);
  if (bytes.byteLength < 32) {
    throw new Error(
      "Patch checkpoint attestation key must be at least 32 bytes",
    );
  }
  return bytes;
}

export function assertPatchCheckpointAttestationKey(
  key: PatchCheckpointAttestationKey,
): void {
  keyBytes(key);
}

function trainingBundleAttestationBody(bundle: PatchTrainingBundleBody) {
  const curationPolicyDigests = [
    ...new Set(
      bundle.records.map((record) => record.metadata.curationPolicyDigest),
    ),
  ];
  if (curationPolicyDigests.length !== 1) {
    throw new Error(
      "Patch training bundle must use one curation policy before attestation",
    );
  }

  return PatchTrainingBundleAttestationSchema.omit({ signature: true }).parse({
    schemaVersion: 1,
    purpose: "braintrust-structural-publication",
    projectScopeId: bundle.projectScopeId,
    bundleDigest: bundle.bundleDigest,
    recordCount: bundle.records.length,
    curationPolicyDigest: curationPolicyDigests[0],
    consentReceiptDigests: [
      ...new Set(
        bundle.records.map((record) => record.metadata.consentReceiptDigest),
      ),
    ].sort(),
  });
}

function trainingBundleSignature(
  body: ReturnType<typeof trainingBundleAttestationBody>,
  key: PatchCheckpointAttestationKey,
): string {
  return createHmac("sha256", keyBytes(key))
    .update("buildlabs.patch-model.training-bundle-attestation.v1")
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

export function attestPatchTrainingBundle(
  input: PatchTrainingBundleBody,
  key: PatchCheckpointAttestationKey,
): PatchTrainingBundle {
  const bundle = PatchTrainingBundleBodySchema.parse(input);
  const attestation = trainingBundleAttestationBody(bundle);
  return PatchTrainingBundleSchema.parse({
    ...bundle,
    attestation: {
      ...attestation,
      signature: trainingBundleSignature(attestation, key),
    },
  });
}

export function verifyPatchTrainingBundle(
  input: PatchTrainingBundle,
  key: PatchCheckpointAttestationKey,
): PatchTrainingBundle {
  const bundle = PatchTrainingBundleSchema.parse(input);
  const body = PatchTrainingBundleBodySchema.parse({
    schemaVersion: bundle.schemaVersion,
    projectScopeId: bundle.projectScopeId,
    records: bundle.records,
    bundleDigest: bundle.bundleDigest,
  });
  const expectedAttestation = trainingBundleAttestationBody(body);
  const actualAttestation = PatchTrainingBundleAttestationSchema.omit({
    signature: true,
  }).parse({
    schemaVersion: bundle.attestation.schemaVersion,
    purpose: bundle.attestation.purpose,
    projectScopeId: bundle.attestation.projectScopeId,
    bundleDigest: bundle.attestation.bundleDigest,
    recordCount: bundle.attestation.recordCount,
    curationPolicyDigest: bundle.attestation.curationPolicyDigest,
    consentReceiptDigests: bundle.attestation.consentReceiptDigests,
  });
  if (canonicalJson(actualAttestation) !== canonicalJson(expectedAttestation)) {
    throw new Error("Patch training bundle attestation context does not match");
  }

  const actualSignature = Buffer.from(bundle.attestation.signature, "hex");
  const expectedSignature = Buffer.from(
    trainingBundleSignature(expectedAttestation, key),
    "hex",
  );
  if (
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("Patch training bundle attestation signature is invalid");
  }
  return bundle;
}

function attestationBody(
  outcome: PatchCheckpointOutcome,
  context: PatchCheckpointAttestationContext,
) {
  const modelResource = FireworksModelResourceSchema.parse(
    context.modelResource,
  );
  return PatchCheckpointAttestationSchema.omit({ signature: true }).parse({
    schemaVersion: 1,
    role: context.role,
    projectScopeId: context.projectScopeId,
    dataset: context.dataset,
    modelResourceDigest: sha256(modelResource),
    resultDigest: digestJson(outcome),
  });
}

function sign(
  body: ReturnType<typeof attestationBody>,
  key: PatchCheckpointAttestationKey,
): string {
  return createHmac("sha256", keyBytes(key))
    .update("buildlabs.patch-model.checkpoint-attestation.v1")
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

export function attestPatchCheckpointResult(
  input: PatchCheckpointOutcome,
  context: PatchCheckpointAttestationContext,
  key: PatchCheckpointAttestationKey,
): PatchCheckpointResult {
  const outcome = PatchCheckpointOutcomeSchema.parse(input);
  const body = attestationBody(outcome, context);
  return PatchCheckpointResultSchema.parse({
    ...outcome,
    attestation: {
      ...body,
      signature: sign(body, key),
    },
  });
}

export function verifyPatchCheckpointResult(
  input: PatchCheckpointResult,
  context: PatchCheckpointAttestationContext,
  key: PatchCheckpointAttestationKey,
): PatchCheckpointResult {
  const result = PatchCheckpointResultSchema.parse(input);
  const outcome = PatchCheckpointOutcomeSchema.parse({
    caseId: result.caseId,
    outputDigest: result.outputDigest,
    reward: result.reward,
  });
  const expectedBody = attestationBody(outcome, context);
  const actualBody = PatchCheckpointAttestationSchema.omit({
    signature: true,
  }).parse({
    schemaVersion: result.attestation.schemaVersion,
    role: result.attestation.role,
    projectScopeId: result.attestation.projectScopeId,
    dataset: result.attestation.dataset,
    modelResourceDigest: result.attestation.modelResourceDigest,
    resultDigest: result.attestation.resultDigest,
  });

  if (canonicalJson(actualBody) !== canonicalJson(expectedBody)) {
    throw new Error(
      `Patch checkpoint ${context.role} attestation context does not match`,
    );
  }

  const actualSignature = Buffer.from(result.attestation.signature, "hex");
  const expectedSignature = Buffer.from(sign(expectedBody, key), "hex");
  if (
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error(
      `Patch checkpoint ${context.role} attestation signature is invalid`,
    );
  }

  return result;
}

function comparisonSignature(
  body: PatchHeldOutComparisonBody,
  key: PatchCheckpointAttestationKey,
): string {
  return createHmac("sha256", keyBytes(key))
    .update("buildlabs.patch-model.heldout-comparison.v1")
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

export function attestPatchHeldOutComparison(
  input: PatchHeldOutComparisonBody,
  key: PatchCheckpointAttestationKey,
): PatchHeldOutComparison {
  const body = PatchHeldOutComparisonBodySchema.parse(input);
  return PatchHeldOutComparisonSchema.parse({
    ...body,
    attestation: {
      schemaVersion: 1,
      purpose: "manual-promotion-eligibility",
      comparisonDigest: digestJson(body),
      signature: comparisonSignature(body, key),
    },
  });
}

export function verifyPatchHeldOutComparison(
  input: PatchHeldOutComparison,
  key: PatchCheckpointAttestationKey,
): PatchHeldOutComparison {
  const comparison = PatchHeldOutComparisonSchema.parse(input);
  const body = PatchHeldOutComparisonBodySchema.parse({
    schemaVersion: comparison.schemaVersion,
    projectScopeId: comparison.projectScopeId,
    dataset: comparison.dataset,
    base: comparison.base,
    candidate: comparison.candidate,
    comparisonBaseExperimentId: comparison.comparisonBaseExperimentId,
    comparisonExperimentName: comparison.comparisonExperimentName,
    scores: comparison.scores,
  });
  const attestation = PatchHeldOutComparisonAttestationSchema.parse(
    comparison.attestation,
  );
  const expectedDigest = digestJson(body);
  if (attestation.comparisonDigest !== expectedDigest) {
    throw new Error("Patch held-out comparison attestation does not match");
  }

  const actualSignature = Buffer.from(attestation.signature, "hex");
  const expectedSignature = Buffer.from(comparisonSignature(body, key), "hex");
  if (
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("Patch held-out comparison signature is invalid");
  }
  return comparison;
}
