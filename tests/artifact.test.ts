import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  artifactDownloadPath,
  CandidateRankingSchema,
  CandidateProvenPayloadSchema,
  OutboxEventSchema,
  ProvenArtifactSchema,
} from "../src/domain/artifact.js";
import { sha256 } from "../src/lib/canonical-json.js";
import { artifact } from "./fixtures.js";

describe("candidate.proven artifact contract", () => {
  it("uses a portable download path bound to the run and artifact identities", () => {
    const runId = randomUUID();
    const artifactId = randomUUID();
    const revisionHash = sha256("revision");

    expect(
      ProvenArtifactSchema.parse({
        ...artifact(runId, revisionHash),
        artifactId,
        uri: artifactDownloadPath(runId, artifactId),
      }).uri,
    ).toBe(`/v1/build-runs/${runId}/artifacts/${artifactId}`);

    expect(() =>
      ProvenArtifactSchema.parse({
        ...artifact(runId, revisionHash),
        artifactId,
        uri: artifactDownloadPath(randomUUID(), artifactId),
      }),
    ).toThrow();

    expect(() =>
      ProvenArtifactSchema.parse({
        ...artifact(runId, revisionHash),
        artifactId,
        uri: `/v1/build-runs/${runId}/artifacts/../../etc/passwd`,
      }),
    ).toThrow();
  });

  it("rejects cross-identity candidate and outbox payloads", () => {
    const runId = randomUUID();
    const revisionHash = sha256("revision");
    const traceId = "trace-test";
    const provenArtifact = artifact(runId, revisionHash);
    const payload = CandidateProvenPayloadSchema.parse({
      runId,
      projectId: "project-test",
      candidateId: "candidate-test",
      contractHash: sha256("contract"),
      revisionHash,
      sandboxId: "sandbox-test",
      previewPort: 3000,
      artifact: provenArtifact,
      traceId,
      ranking: {
        provider: "braintrust",
        policyVersion: "braintrust-preference-v1",
        preferenceSatisfaction: 0.75,
        scoreTuple: [0.75],
        traceId,
      },
    });

    expect(() =>
      CandidateProvenPayloadSchema.parse({
        ...payload,
        runId: randomUUID(),
      }),
    ).toThrow();

    expect(() =>
      OutboxEventSchema.parse({
        eventId: randomUUID(),
        type: "candidate.proven",
        runId,
        revisionHash,
        traceId: "another-trace",
        payload,
        createdAt: "2026-07-23T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects ranking evidence with an unknown policy or malformed tuple", () => {
    const ranking = {
      provider: "braintrust",
      policyVersion: "braintrust-preference-v1",
      preferenceSatisfaction: 0.75,
      scoreTuple: [0.75],
      traceId: "trace-test",
    };

    expect(
      CandidateRankingSchema.safeParse({
        ...ranking,
        policyVersion: "braintrust-preference-v2",
      }).success,
    ).toBe(false);
    expect(
      CandidateRankingSchema.safeParse({
        ...ranking,
        scoreTuple: [0.5],
      }).success,
    ).toBe(false);
    expect(
      CandidateRankingSchema.safeParse({
        ...ranking,
        scoreTuple: [0.75, 1],
      }).success,
    ).toBe(false);
  });
});
