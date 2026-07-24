import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  NoProvenCandidateError,
  selectProvenWinner,
} from "../src/orchestration/application/winner-selection.js";
import {
  CANDIDATE_RANKING_POLICY_VERSION,
  CandidateProvenPayloadSchema,
  type CandidateProvenPayload,
} from "../src/domain/artifact.js";
import { artifact } from "./fixtures.js";

describe("selectProvenWinner", () => {
  it("ranks only identity-matching proven candidates and uses a stable tie-breaker", () => {
    const lower = candidate("candidate-z", 0.7);
    const tiedLater = candidate("candidate-b", 0.9);
    const tiedWinner = candidate("candidate-a", 0.9);
    const wrongContract = candidate("candidate-perfect-but-stale", 1, {
      contractHash: "f".repeat(64),
    });

    const selected = selectProvenWinner(
      [lower, tiedLater, wrongContract, tiedWinner],
      {
        projectId: "project-current",
        contractHash: "a".repeat(64),
      },
    );

    expect(selected.candidateId).toBe("candidate-a");
  });

  it("fails closed when no proven event matches the current project contract", () => {
    expect(() =>
      selectProvenWinner([candidate("candidate-stale", 1)], {
        projectId: "project-current",
        contractHash: "b".repeat(64),
      }),
    ).toThrow(NoProvenCandidateError);
  });

  it("rejects unrecognized policies and malformed score tuples", () => {
    const valid = candidate("candidate-valid", 0.9);
    const scope = {
      projectId: "project-current",
      contractHash: "a".repeat(64),
    };
    const wrongPolicy = {
      ...valid,
      ranking: {
        ...valid.ranking,
        policyVersion: "braintrust-preference-v2",
      },
    };
    const mismatchedTuple = {
      ...valid,
      ranking: {
        ...valid.ranking,
        scoreTuple: [0.8],
      },
    };
    const malformedTuple = {
      ...valid,
      ranking: {
        ...valid.ranking,
        scoreTuple: [0.9, 1],
      },
    };

    for (const invalid of [wrongPolicy, mismatchedTuple, malformedTuple]) {
      expect(() =>
        selectProvenWinner(
          [invalid as unknown as CandidateProvenPayload],
          scope,
        ),
      ).toThrow();
    }
  });
});

function candidate(
  candidateId: string,
  preferenceSatisfaction: number,
  overrides: Partial<CandidateProvenPayload> = {},
): CandidateProvenPayload {
  const runId = randomUUID();
  const revisionHash = "c".repeat(64);
  const provenArtifact = artifact(runId, revisionHash);
  return CandidateProvenPayloadSchema.parse({
    runId,
    projectId: "project-current",
    candidateId,
    contractHash: "a".repeat(64),
    revisionHash,
    sandboxId: `sandbox-${candidateId}`,
    previewPort: 3000,
    artifact: provenArtifact,
    traceId: `trace-${candidateId}`,
    ranking: {
      provider: "braintrust",
      policyVersion: CANDIDATE_RANKING_POLICY_VERSION,
      preferenceSatisfaction,
      scoreTuple: [preferenceSatisfaction],
      traceId: `trace-${candidateId}`,
    },
    ...overrides,
  });
}
