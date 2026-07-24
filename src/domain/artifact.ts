import { z } from "zod";

import { Sha256Schema } from "./contract.js";

const EntityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const TraceIdSchema = z.string().min(1).max(512);

export function artifactDownloadPath(
  runId: string,
  artifactId: string,
): string {
  return `/v1/build-runs/${runId}/artifacts/${artifactId}`;
}

export function artifactArchiveFilename(artifact: {
  artifactId: string;
  runId: string;
  revisionHash: string;
}): string {
  return `${artifact.runId}-${artifact.revisionHash.slice(0, 16)}-${artifact.artifactId}.tar.gz`;
}

export const ProvenArtifactSchema = z
  .object({
    artifactId: z.uuid(),
    runId: z.uuid(),
    revisionHash: Sha256Schema,
    format: z.literal("tar.gz"),
    uri: z.string().startsWith("/v1/build-runs/").max(512),
    sha256: Sha256Schema,
    sizeBytes: z.number().int().positive(),
    dockerfilePath: z.literal("Dockerfile"),
    daytonaSnapshot: z.string().min(1).max(128),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (
      artifact.uri !== artifactDownloadPath(artifact.runId, artifact.artifactId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Artifact URI does not match its run and artifact identity",
        path: ["uri"],
      });
    }
  });

export type ProvenArtifact = z.infer<typeof ProvenArtifactSchema>;

export const CANDIDATE_RANKING_POLICY_VERSION =
  "braintrust-preference-v1" as const;

export const CandidateRankingSchema = z
  .object({
    provider: z.literal("braintrust"),
    policyVersion: z.literal(CANDIDATE_RANKING_POLICY_VERSION),
    preferenceSatisfaction: z.number().min(0).max(1),
    scoreTuple: z.tuple([z.number().min(0).max(1)]),
    traceId: TraceIdSchema,
  })
  .strict()
  .superRefine((ranking, context) => {
    if (ranking.scoreTuple[0] !== ranking.preferenceSatisfaction) {
      context.addIssue({
        code: "custom",
        message:
          "Ranking score tuple does not match the policy's named preference score",
        path: ["scoreTuple", 0],
      });
    }
  });

export const CandidateProvenPayloadSchema = z
  .object({
    runId: z.uuid(),
    projectId: EntityIdSchema,
    candidateId: EntityIdSchema,
    contractHash: Sha256Schema,
    revisionHash: Sha256Schema,
    sandboxId: z.string().min(1).max(512),
    previewPort: z.number().int().min(1).max(65_535),
    artifact: ProvenArtifactSchema,
    traceId: TraceIdSchema,
    ranking: CandidateRankingSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.artifact.runId !== payload.runId) {
      context.addIssue({
        code: "custom",
        message: "Artifact run identity does not match the proven candidate",
        path: ["artifact", "runId"],
      });
    }
    if (payload.artifact.revisionHash !== payload.revisionHash) {
      context.addIssue({
        code: "custom",
        message: "Artifact revision does not match the proven candidate",
        path: ["artifact", "revisionHash"],
      });
    }
    if (payload.ranking.traceId !== payload.traceId) {
      context.addIssue({
        code: "custom",
        message: "Ranking trace does not match the proven candidate trace",
        path: ["ranking", "traceId"],
      });
    }
  });

export const OutboxEventSchema = z
  .object({
    eventId: z.uuid(),
    type: z.literal("candidate.proven"),
    runId: z.uuid(),
    revisionHash: Sha256Schema,
    traceId: TraceIdSchema,
    payload: CandidateProvenPayloadSchema,
    createdAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.payload.runId !== event.runId) {
      context.addIssue({
        code: "custom",
        message: "Outbox run identity does not match its payload",
        path: ["payload", "runId"],
      });
    }
    if (event.payload.revisionHash !== event.revisionHash) {
      context.addIssue({
        code: "custom",
        message: "Outbox revision does not match its payload",
        path: ["payload", "revisionHash"],
      });
    }
    if (event.payload.traceId !== event.traceId) {
      context.addIssue({
        code: "custom",
        message: "Outbox trace does not match its payload",
        path: ["payload", "traceId"],
      });
    }
  });

export type CandidateProvenPayload = z.infer<
  typeof CandidateProvenPayloadSchema
>;
export type OutboxEvent = z.infer<typeof OutboxEventSchema>;
