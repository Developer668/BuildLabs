import { z } from "zod";

import { digestJson } from "../lib/canonical-json.js";
import { Sha256Schema } from "./contract.js";
import { PatchRewardSchema, PatchTrainingRecordSchema } from "./patch-model.js";

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const PatchProviderSourceFileSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9._/-]+$/),
  content: z.string().max(1_000_000),
});
export type PatchProviderSourceFile = z.infer<
  typeof PatchProviderSourceFileSchema
>;

const PatchProviderSystemMessageSchema = z.strictObject({
  role: z.literal("system"),
  content: z.string().min(1).max(20_000),
});

const PatchProviderUserMessageSchema = z.strictObject({
  role: z.literal("user"),
  content: z.string().min(1).max(2_000_000),
});

const PatchProviderAssistantToolMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.null(),
  tool_calls: z
    .array(
      z.strictObject({
        id: OpaqueIdSchema,
        type: z.literal("function"),
        function: z.strictObject({
          name: z.literal("apply_patch"),
          arguments: z.string().min(1).max(2_000_000),
        }),
      }),
    )
    .length(1),
});

const PatchProviderToolMessageSchema = z.strictObject({
  role: z.literal("tool"),
  tool_call_id: OpaqueIdSchema,
  content: z.string().min(1).max(20_000),
});

const PatchProviderAssistantFinalMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.string().min(1).max(2_000),
});

export const PatchProviderMessageSchema = z.union([
  PatchProviderSystemMessageSchema,
  PatchProviderUserMessageSchema,
  PatchProviderAssistantToolMessageSchema,
  PatchProviderToolMessageSchema,
  PatchProviderAssistantFinalMessageSchema,
]);
export type PatchProviderMessage = z.infer<typeof PatchProviderMessageSchema>;

export const PatchProviderToolDefinitionSchema = z.strictObject({
  type: z.literal("function"),
  function: z.strictObject({
    name: z.literal("apply_patch"),
    description: z.string().min(1).max(1_000),
    strict: z.literal(true),
    parameters: z.strictObject({
      type: z.literal("object"),
      additionalProperties: z.literal(false),
      properties: z.strictObject({
        patch: z.strictObject({
          type: z.literal("string"),
        }),
      }),
      required: z.tuple([z.literal("patch")]),
    }),
  }),
});
export type PatchProviderToolDefinition = z.infer<
  typeof PatchProviderToolDefinitionSchema
>;

const PatchProviderExampleFields = {
  schemaVersion: z.literal(1),
  projectScopeId: Sha256Schema,
  exampleId: Sha256Schema,
  split: z.enum(["train", "heldout"]),
  structuralRecord: PatchTrainingRecordSchema,
  messages: z.array(PatchProviderMessageSchema).length(5),
  tools: z.array(PatchProviderToolDefinitionSchema).length(1),
  expected: z.strictObject({
    originalPatchDigest: Sha256Schema,
    providerPatchDigest: Sha256Schema,
    proofDigest: Sha256Schema,
    reward: PatchRewardSchema,
  }),
  metadata: z.strictObject({
    contractRevision: z.number().int().positive(),
    dataUseConsent: z.literal("granted"),
    consentReceiptDigest: Sha256Schema,
    sourceDigest: Sha256Schema,
    providerSourceDigest: Sha256Schema,
    requestedChangeDigest: Sha256Schema,
    priorRequirementDigests: z.array(Sha256Schema).max(500),
    taskGroupDigest: Sha256Schema,
    structuralRecordDigest: Sha256Schema,
    curationPolicyDigest: Sha256Schema,
    providerPolicyDigest: Sha256Schema,
    factPlaceholderCount: z.number().int().nonnegative().max(10_000),
  }),
  exampleDigest: Sha256Schema,
} as const;

function validatePatchProviderExample(
  example: z.infer<
    ReturnType<typeof z.strictObject<typeof PatchProviderExampleFields>>
  >,
  context: z.core.$RefinementCtx,
): void {
  const roles = example.messages.map((message) => message.role);
  if (roles.join(",") !== "system,user,assistant,tool,assistant") {
    context.addIssue({
      code: "custom",
      message: "Patch provider messages must form one complete tool trajectory",
      path: ["messages"],
    });
  }

  const assistantTool = example.messages[2];
  const toolResult = example.messages[3];
  if (
    assistantTool?.role !== "assistant" ||
    !("tool_calls" in assistantTool) ||
    toolResult?.role !== "tool" ||
    assistantTool.tool_calls[0]?.id !== toolResult.tool_call_id
  ) {
    context.addIssue({
      code: "custom",
      message: "Patch provider tool result must match the assistant tool call",
      path: ["messages"],
    });
  }

  if (
    example.projectScopeId !== example.structuralRecord.projectScopeId ||
    example.exampleId !== example.structuralRecord.exampleId ||
    example.split !== example.structuralRecord.split ||
    example.metadata.dataUseConsent !==
      example.structuralRecord.metadata.dataUseConsent ||
    example.metadata.consentReceiptDigest !==
      example.structuralRecord.metadata.consentReceiptDigest ||
    example.metadata.curationPolicyDigest !==
      example.structuralRecord.metadata.curationPolicyDigest ||
    example.metadata.structuralRecordDigest !==
      digestJson(example.structuralRecord) ||
    example.expected.reward.evidenceDigest !== example.expected.proofDigest
  ) {
    context.addIssue({
      code: "custom",
      message: "Patch provider example does not match its governed record",
      path: ["structuralRecord"],
    });
  }

  const body = {
    schemaVersion: example.schemaVersion,
    projectScopeId: example.projectScopeId,
    exampleId: example.exampleId,
    split: example.split,
    structuralRecord: example.structuralRecord,
    messages: example.messages,
    tools: example.tools,
    expected: example.expected,
    metadata: example.metadata,
  };
  if (example.exampleDigest !== digestJson(body)) {
    context.addIssue({
      code: "custom",
      message: "Patch provider example digest does not match its contents",
      path: ["exampleDigest"],
    });
  }
}

export const PatchProviderExampleBodySchema = z
  .strictObject(PatchProviderExampleFields)
  .omit({ exampleDigest: true });

export const PatchProviderExampleSchema = z
  .strictObject(PatchProviderExampleFields)
  .superRefine(validatePatchProviderExample);
export type PatchProviderExample = z.infer<typeof PatchProviderExampleSchema>;

const PatchProviderBundleFields = {
  schemaVersion: z.literal(1),
  projectScopeId: Sha256Schema,
  examples: z.array(PatchProviderExampleSchema).min(2).max(100_000),
  bundleDigest: Sha256Schema,
} as const;

export const PatchProviderBundleAttestationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal("fireworks-provider-training"),
  projectScopeId: Sha256Schema,
  bundleDigest: Sha256Schema,
  providerPolicyDigest: Sha256Schema,
  consentReceiptDigests: z.array(Sha256Schema).min(1).max(100_000),
  exampleCount: z.number().int().min(2).max(100_000),
  signature: Sha256Schema,
});
export type PatchProviderBundleAttestation = z.infer<
  typeof PatchProviderBundleAttestationSchema
>;

export const PatchProviderBundleBodySchema = z.strictObject(
  PatchProviderBundleFields,
);

export const PatchProviderBundleSchema = z
  .strictObject({
    ...PatchProviderBundleFields,
    attestation: PatchProviderBundleAttestationSchema,
  })
  .superRefine((bundle, context) => {
    const body = {
      schemaVersion: bundle.schemaVersion,
      projectScopeId: bundle.projectScopeId,
      examples: bundle.examples,
    };
    if (bundle.bundleDigest !== digestJson(body)) {
      context.addIssue({
        code: "custom",
        message: "Patch provider bundle digest does not match its contents",
        path: ["bundleDigest"],
      });
    }
    if (
      bundle.examples.some(
        (example) => example.projectScopeId !== bundle.projectScopeId,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Patch provider bundle cannot mix projects",
        path: ["examples"],
      });
    }
    if (
      !bundle.examples.some((example) => example.split === "train") ||
      !bundle.examples.some((example) => example.split === "heldout")
    ) {
      context.addIssue({
        code: "custom",
        message: "Patch provider bundle requires train and held-out examples",
        path: ["examples"],
      });
    }
  });
export type PatchProviderBundle = z.infer<typeof PatchProviderBundleSchema>;

export const PatchProviderExportAttestationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal("fireworks-provider-export"),
  projectScopeId: Sha256Schema,
  bundleDigest: Sha256Schema,
  bundleAttestationSignature: Sha256Schema,
  providerPolicyDigest: Sha256Schema,
  consentReceiptDigests: z.array(Sha256Schema).min(1).max(100_000),
  format: z.enum(["fireworks-rft-jsonl", "openai-sft-jsonl"]),
  split: z.enum(["train", "heldout"]),
  lineCount: z.number().int().positive(),
  contentSha256: Sha256Schema,
  signature: Sha256Schema,
});
export type PatchProviderExportAttestation = z.infer<
  typeof PatchProviderExportAttestationSchema
>;

export const PatchProviderExportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bundleDigest: Sha256Schema,
  format: z.enum(["fireworks-rft-jsonl", "openai-sft-jsonl"]),
  split: z.enum(["train", "heldout"]),
  lineCount: z.number().int().positive(),
  contentSha256: Sha256Schema,
  content: z.string().min(1).max(100_000_000),
  attestation: PatchProviderExportAttestationSchema,
});
export type PatchProviderExport = z.infer<typeof PatchProviderExportSchema>;
