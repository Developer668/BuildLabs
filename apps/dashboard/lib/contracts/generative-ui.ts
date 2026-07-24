import { z } from "zod";

import {
  BuilderAliasSchema,
  SafeHttpsUrlSchema,
  Sha256Schema,
  parseCustomerSafe,
  safeTextSchema,
} from "./safety";

const ContractNodeSchema = z
  .object({
    component: z.literal("contract"),
    props: z
      .object({
        version: z.number().int().positive(),
        title: safeTextSchema(500),
        summary: safeTextSchema(2_000),
        hardRequirements: z.array(safeTextSchema(1_000)).max(50),
        preferences: z.array(safeTextSchema(1_000)).max(50),
      })
      .strict(),
  })
  .strict();

const PaymentNodeSchema = z
  .object({
    component: z.literal("payment"),
    props: z
      .object({
        proposalVersion: z.number().int().positive(),
        state: z.enum(["awaiting", "verifying", "verified", "failed"]),
        amountLabel: safeTextSchema(100),
        actionUrl: SafeHttpsUrlSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const CandidatesNodeSchema = z
  .object({
    component: z.literal("candidates"),
    props: z
      .object({
        contractVersion: z.number().int().positive(),
        builders: z
          .array(
            z
              .object({
                builderId: BuilderAliasSchema,
                displayName: z.string().regex(/^Builder [1-4]$/),
                status: z.enum([
                  "not_allocated",
                  "queued",
                  "running",
                  "passed",
                  "rejected",
                  "failed",
                  "cancelled",
                  "superseded",
                  "awaiting_proven_event",
                ]),
                stage: z
                  .enum([
                    "queued",
                    "provisioning",
                    "generating",
                    "verifying",
                    "reviewing",
                    "evaluating",
                    "finalizing",
                    "complete",
                  ])
                  .nullable(),
                action: safeTextSchema(300).nullable(),
              })
              .strict(),
          )
          .max(4),
      })
      .strict(),
  })
  .strict();

const VerifiersNodeSchema = z
  .object({
    component: z.literal("verifiers"),
    props: z
      .object({
        contractVersion: z.number().int().positive(),
        checks: z
          .array(
            z
              .object({
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
                status: z.enum([
                  "pending",
                  "running",
                  "pass",
                  "fail",
                  "error",
                  "superseded",
                ]),
                scope: safeTextSchema(1_000),
                completedAt: z.iso.datetime({ offset: true }).nullable(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
  })
  .strict();

const FindingsNodeSchema = z
  .object({
    component: z.literal("findings"),
    props: z
      .object({
        state: z.enum(["pending", "running", "clean", "findings", "error"]),
        critical: z.number().int().nonnegative().max(10_000),
        high: z.number().int().nonnegative().max(10_000),
        medium: z.number().int().nonnegative().max(10_000),
        low: z.number().int().nonnegative().max(10_000),
        summaries: z.array(safeTextSchema(500)).max(20),
      })
      .strict(),
  })
  .strict();

const PreviewNodeSchema = z
  .object({
    component: z.literal("preview"),
    props: z
      .object({
        state: z.enum([
          "unavailable",
          "materializing",
          "ready",
          "expired",
          "revoked",
          "superseded",
        ]),
        contractVersion: z.number().int().positive().nullable(),
        artifactDigest: Sha256Schema.nullable(),
        url: SafeHttpsUrlSchema.nullable(),
        frozen: z.boolean(),
      })
      .strict()
      .superRefine((preview, context) => {
        if (
          preview.state === "ready" &&
          (!preview.frozen ||
            preview.contractVersion === null ||
            preview.artifactDigest === null ||
            preview.url === null)
        ) {
          context.addIssue({
            code: "custom",
            message: "A ready preview must bind one frozen proven artifact",
          });
        }
        if (preview.url !== null && !preview.frozen) {
          context.addIssue({
            code: "custom",
            message: "A mutable preview URL cannot cross this registry",
          });
        }
      }),
  })
  .strict();

const DeploymentNodeSchema = z
  .object({
    component: z.literal("deployment"),
    props: z
      .object({
        state: z.enum([
          "unavailable",
          "deploying",
          "verification_failed",
          "current",
          "replaced",
        ]),
        contractVersion: z.number().int().positive().nullable(),
        artifactDigest: Sha256Schema.nullable(),
        imageDigest: Sha256Schema.nullable(),
        releaseVersion: z.number().int().positive().nullable(),
        url: SafeHttpsUrlSchema.nullable(),
      })
      .strict()
      .superRefine((deployment, context) => {
        if (
          deployment.state === "current" &&
          (deployment.contractVersion === null ||
            deployment.artifactDigest === null ||
            deployment.imageDigest === null ||
            deployment.releaseVersion === null ||
            deployment.url === null)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "A current deployment requires a complete verified receipt",
          });
        }
      }),
  })
  .strict();

const DeliveryNodeSchema = z
  .object({
    component: z.literal("delivery"),
    props: z
      .object({
        state: z.enum([
          "not_started",
          "pending",
          "processing",
          "settled",
          "retrying",
          "dead_lettered",
        ]),
        releaseVersion: z.number().int().positive().nullable(),
        channel: z.enum(["dashboard", "email"]),
        summary: safeTextSchema(500),
      })
      .strict(),
  })
  .strict();

export const GenerativeUiNodeSchema = z.discriminatedUnion("component", [
  ContractNodeSchema,
  PaymentNodeSchema,
  CandidatesNodeSchema,
  VerifiersNodeSchema,
  FindingsNodeSchema,
  PreviewNodeSchema,
  DeploymentNodeSchema,
  DeliveryNodeSchema,
]);

export const GenerativeUiDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z.array(GenerativeUiNodeSchema).min(1).max(12),
  })
  .strict();

export type GenerativeUiNode = z.infer<typeof GenerativeUiNodeSchema>;
export type GenerativeUiDocument = z.infer<typeof GenerativeUiDocumentSchema>;
export type GenerativeUiComponentName = GenerativeUiNode["component"];

export function parseGenerativeUiNode(value: unknown): GenerativeUiNode {
  return parseCustomerSafe(GenerativeUiNodeSchema, value);
}

export function parseGenerativeUiDocument(
  value: unknown,
): GenerativeUiDocument {
  return parseCustomerSafe(GenerativeUiDocumentSchema, value);
}
