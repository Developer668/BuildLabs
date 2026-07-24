import { z } from "zod";

import {
  containsUnsafeTextControls,
  IsoTimestampSchema,
  SafeHttpsUrlSchema,
  SafeRelativePathSchema,
  Sha256Schema,
} from "./safety";

const OperatorTextSchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine(
    (value) => !containsUnsafeTextControls(value),
    "Text contains unsafe control characters",
  )
  .refine((value) => !/[<>]/.test(value), "HTML is not accepted")
  .refine(
    (value) =>
      !/\b(?:bearer\s+[a-z0-9._~+/=-]+|sk[-_][a-z0-9_-]{8,}|api[-_ ]?key\s*[:=]|access[-_ ]?token\s*[:=])/i.test(
        value,
      ),
    "Credential-shaped text is not accepted",
  );

const UuidSchema = z.uuid();

export const OperatorVerifierReceiptSchema = z
  .object({
    receiptId: z.string().min(1).max(128),
    kind: z.enum([
      "source_integrity",
      "dependency_bootstrap",
      "build",
      "configured_tests",
      "requirement_command",
      "rendered_http",
      "unsupported_claims",
      "visual_claims",
      "code_review",
      "contract_evaluation",
      "proof_gate",
    ]),
    status: z.enum(["pending", "running", "pass", "fail", "error"]),
    scope: OperatorTextSchema.max(1_000),
    evidenceDigest: Sha256Schema.nullable(),
    completedAt: IsoTimestampSchema.nullable(),
  })
  .strict();

export const OperatorCandidateSchema = z
  .object({
    runId: UuidSchema,
    candidateId: z.string().min(1).max(128),
    displayName: z.string().regex(/^Candidate [1-4]$/),
    status: z.enum([
      "queued",
      "running",
      "passed",
      "rejected",
      "failed",
      "cancelled",
    ]),
    stage: z.enum([
      "queued",
      "provisioning",
      "generating",
      "verifying",
      "reviewing",
      "evaluating",
      "finalizing",
      "complete",
    ]),
    boundedAction: OperatorTextSchema.max(500).nullable(),
    revisionHash: Sha256Schema.nullable(),
    artifactDigest: Sha256Schema.nullable(),
    preview: z
      .object({
        state: z.enum(["unavailable", "probe_required", "live"]),
        url: SafeHttpsUrlSchema.nullable(),
      })
      .strict(),
    diff: z
      .object({
        state: z.enum(["unavailable", "recorded"]),
        files: z.number().int().nonnegative().max(10_000),
        additions: z.number().int().nonnegative().max(10_000_000),
        deletions: z.number().int().nonnegative().max(10_000_000),
        paths: z.array(SafeRelativePathSchema).max(20),
      })
      .strict(),
    componentTree: z
      .array(
        z
          .object({
            path: SafeRelativePathSchema,
            kind: z.enum([
              "route",
              "layout",
              "component",
              "action",
              "data",
              "style",
            ]),
            label: OperatorTextSchema.max(200),
          })
          .strict(),
      )
      .max(250),
    receipts: z.array(OperatorVerifierReceiptSchema).max(500),
    codeRabbit: z
      .object({
        state: z.enum(["pending", "running", "clean", "findings", "error"]),
        policyDigest: Sha256Schema.nullable(),
        findings: z
          .array(
            z
              .object({
                findingId: z.string().min(1).max(128),
                severity: z.enum(["critical", "high", "medium", "low"]),
                state: z.enum(["open", "repaired", "dismissed_by_policy"]),
                path: SafeRelativePathSchema,
                line: z.number().int().positive().nullable(),
                summary: OperatorTextSchema.max(1_000),
              })
              .strict(),
          )
          .max(250),
      })
      .strict(),
    braintrust: z
      .object({
        state: z.enum(["unavailable", "pending", "recorded", "flush_failed"]),
        hardRequirementsPassed: z.boolean().nullable(),
        preferenceScore: z.number().min(0).max(1).nullable(),
        designScore: z.number().min(0).max(1).nullable(),
        unsupportedClaimsPassed: z.boolean().nullable(),
      })
      .strict(),
    updatedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      (candidate.preview.state === "live") !==
      (candidate.preview.url !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A live operator preview must have one HTTPS URL",
      });
    }
    if (
      candidate.status === "passed" &&
      (candidate.revisionHash === null || candidate.artifactDigest === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A passed candidate must bind a revision and artifact",
      });
    }
    if (
      candidate.braintrust.hardRequirementsPassed === false &&
      candidate.status === "passed"
    ) {
      context.addIssue({
        code: "custom",
        message: "A hard requirement failure cannot produce a passed candidate",
      });
    }
  });

export const OperatorProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    fixture: z.boolean(),
    projectId: UuidSchema,
    title: OperatorTextSchema.max(500),
    lifecycle: z.string().min(1).max(128),
    aggregateRevision: z.number().int().nonnegative(),
    contract: z
      .object({
        version: z.number().int().positive(),
        digest: Sha256Schema,
        lockedAt: IsoTimestampSchema,
        summary: OperatorTextSchema.max(5_000),
        requirements: z
          .array(
            z
              .object({
                id: z.string().min(1).max(128),
                priority: z.enum(["hard", "preference"]),
                text: OperatorTextSchema.max(2_000),
              })
              .strict(),
          )
          .max(500),
      })
      .strict(),
    proposal: z
      .object({
        version: z.number().int().positive(),
        state: z.enum([
          "draft",
          "sent",
          "awaiting_revision",
          "awaiting_payment",
          "paid",
          "superseded",
        ]),
        amountMinor: z.number().int().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
    payment: z
      .object({
        state: z.enum(["awaiting", "verifying", "verified", "failed"]),
        evidenceSource: z
          .enum(["signed_webhook", "provider_reconciliation"])
          .nullable(),
        verifiedAt: IsoTimestampSchema.nullable(),
      })
      .strict(),
    candidates: z.array(OperatorCandidateSchema).length(4),
    providers: z
      .array(
        z
          .object({
            name: z.enum([
              "Daytona",
              "Fireworks",
              "Braintrust",
              "CodeRabbit",
              "Fly.io",
              "Resend",
              "Stripe",
              "ElevenLabs",
            ]),
            state: z.enum([
              "unconfigured",
              "configured",
              "healthy",
              "degraded",
              "unavailable",
            ]),
            checkedAt: IsoTimestampSchema.nullable(),
            detail: OperatorTextSchema.max(500),
          })
          .strict(),
      )
      .max(8),
    deployment: z
      .object({
        state: z.enum([
          "not_started",
          "queued",
          "deploying",
          "verifying",
          "healthy",
          "failed",
        ]),
        contractVersion: z.number().int().positive().nullable(),
        artifactDigest: Sha256Schema.nullable(),
        imageDigest: Sha256Schema.nullable(),
        url: SafeHttpsUrlSchema.nullable(),
      })
      .strict(),
    deliveryEffects: z
      .array(
        z
          .object({
            effectId: z.string().min(1).max(128),
            kind: z.enum([
              "send_proposal",
              "send_payment_confirmation",
              "send_dashboard_access",
              "send_proven_preview",
              "deploy_proven_candidate",
              "send_final_delivery",
            ]),
            state: z.enum([
              "pending",
              "processing",
              "settled",
              "retrying",
              "dead_lettered",
            ]),
            attempt: z.number().int().nonnegative().max(100),
            updatedAt: IsoTimestampSchema,
          })
          .strict(),
      )
      .max(500),
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((project, context) => {
    if (
      project.payment.state === "verified" &&
      (project.payment.verifiedAt === null ||
        project.payment.evidenceSource === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Verified payment requires its evidence source and timestamp",
      });
    }
    if (
      project.payment.state !== "verified" &&
      project.candidates.some((candidate) => candidate.status !== "queued")
    ) {
      context.addIssue({
        code: "custom",
        message: "Candidates cannot run before verified payment",
      });
    }
    if (new Set(project.candidates.map(({ runId }) => runId)).size !== 4) {
      context.addIssue({
        code: "custom",
        message: "Candidate run identities must be unique",
      });
    }
  });

export type OperatorProject = z.infer<typeof OperatorProjectSchema>;
export type OperatorCandidate = z.infer<typeof OperatorCandidateSchema>;
export type OperatorVerifierReceipt = z.infer<
  typeof OperatorVerifierReceiptSchema
>;

export function parseOperatorProject(value: unknown): OperatorProject {
  return OperatorProjectSchema.parse(value);
}
