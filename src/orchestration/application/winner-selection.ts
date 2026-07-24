import {
  CandidateProvenPayloadSchema,
  type CandidateProvenPayload,
} from "../../domain/artifact.js";

export interface WinnerSelectionScope {
  projectId: string;
  contractHash: string;
}

export class NoProvenCandidateError extends Error {
  constructor(scope: WinnerSelectionScope) {
    super(
      `No proven candidate matches project ${scope.projectId} and its current contract`,
    );
    this.name = "NoProvenCandidateError";
  }
}

export function selectProvenWinner(
  inputs: CandidateProvenPayload[],
  scope: WinnerSelectionScope,
): CandidateProvenPayload {
  const unique = new Map<string, CandidateProvenPayload>();
  for (const input of inputs) {
    const candidate = CandidateProvenPayloadSchema.parse(input);
    if (
      candidate.projectId !== scope.projectId ||
      candidate.contractHash !== scope.contractHash
    ) {
      continue;
    }
    unique.set(`${candidate.runId}:${candidate.revisionHash}`, candidate);
  }

  const ranked = [...unique.values()].sort((left, right) => {
    const scoreDifference = compareScoreTuplesDescending(
      left.ranking.scoreTuple,
      right.ranking.scoreTuple,
    );
    return (
      scoreDifference ||
      left.candidateId.localeCompare(right.candidateId) ||
      left.runId.localeCompare(right.runId)
    );
  });
  const winner = ranked[0];
  if (!winner) {
    throw new NoProvenCandidateError(scope);
  }
  return winner;
}

function compareScoreTuplesDescending(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
