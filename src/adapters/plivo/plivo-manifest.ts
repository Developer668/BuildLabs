import { z } from "zod";

const EnvironmentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]+$/u);

export const PlivoPstnManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z
      .object({
        name: z.literal("plivo"),
        product: z.literal("zentrunk"),
        direction: z.literal("inbound_only"),
      })
      .strict(),
    plivo: z
      .object({
        authIdEnvironmentVariable: EnvironmentNameSchema,
        authTokenEnvironmentVariable: EnvironmentNameSchema,
        numberEnvironmentVariable: EnvironmentNameSchema,
        reconciliationSecretEnvironmentVariable: EnvironmentNameSchema,
        originationUri: z
          .object({
            namePrefix: z.literal("BuildLabs managed v1"),
            destination: z.literal("sip.rtc.elevenlabs.io:5061;transport=tls"),
            authenticationNeeded: z.literal(false),
          })
          .strict(),
        trunk: z
          .object({
            namePrefix: z.literal("BuildLabs managed v1"),
            direction: z.literal("inbound"),
            secure: z.literal(true),
            desiredStatus: z.literal("enabled"),
            stagingStatus: z.literal("disabled"),
            fallbackUriAllowed: z.literal(false),
            credentialAllowed: z.literal(false),
            ipAclAllowed: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    elevenLabs: z
      .object({
        apiKeyEnvironmentVariable: EnvironmentNameSchema,
        agentIdEnvironmentVariable: EnvironmentNameSchema,
        branchIdEnvironmentVariable: EnvironmentNameSchema,
        versionIdEnvironmentVariable: EnvironmentNameSchema,
        phoneLabelPrefix: z.literal("BuildLabs managed v1"),
        provider: z.literal("sip_trunk"),
        environment: z.literal("testing"),
        mediaEncryption: z.literal("required"),
        storeSipMessages: z.literal(false),
        outboundTrunkAllowed: z.literal(false),
      })
      .strict(),
    reconciliation: z
      .object({
        defaultMode: z.literal("plan"),
        expectedBaseDigestRequiredForApply: z.literal(true),
        maximumPages: z.literal(100),
        pageSize: z.literal(20),
        requestTimeoutMs: z.literal(15_000),
        blindMutationRetries: z.literal(0),
      })
      .strict(),
    deployment: z
      .object({
        testNumberOnly: z.literal(true),
        explicitNumberRoutingFlagRequired: z.literal(true),
        allowProductionTraffic: z.literal(false),
        allowOutboundCalls: z.literal(false),
        allowNumberPurchase: z.literal(false),
        allowNumberRelease: z.literal(false),
        allowDelete: z.literal(false),
        plivoRecordingEnabled: z.literal(false),
        plivoTranscriptionEnabled: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type PlivoPstnManifest = z.infer<typeof PlivoPstnManifestSchema>;

export const BUILDLABS_PLIVO_PSTN_MANIFEST: PlivoPstnManifest =
  PlivoPstnManifestSchema.parse({
    schemaVersion: 1,
    provider: {
      name: "plivo",
      product: "zentrunk",
      direction: "inbound_only",
    },
    plivo: {
      authIdEnvironmentVariable: "PLIVO_AUTH_ID",
      authTokenEnvironmentVariable: "PLIVO_AUTH_TOKEN",
      numberEnvironmentVariable: "PLIVO_BUILDLABS_NUMBER",
      reconciliationSecretEnvironmentVariable: "PLIVO_RECONCILIATION_SECRET",
      originationUri: {
        namePrefix: "BuildLabs managed v1",
        destination: "sip.rtc.elevenlabs.io:5061;transport=tls",
        authenticationNeeded: false,
      },
      trunk: {
        namePrefix: "BuildLabs managed v1",
        direction: "inbound",
        secure: true,
        desiredStatus: "enabled",
        stagingStatus: "disabled",
        fallbackUriAllowed: false,
        credentialAllowed: false,
        ipAclAllowed: false,
      },
    },
    elevenLabs: {
      apiKeyEnvironmentVariable: "ELEVENLABS_API_KEY",
      agentIdEnvironmentVariable: "ELEVENLABS_AGENT_ID",
      branchIdEnvironmentVariable: "ELEVENLABS_BRANCH_ID",
      versionIdEnvironmentVariable: "ELEVENLABS_AGENT_VERSION_ID",
      phoneLabelPrefix: "BuildLabs managed v1",
      provider: "sip_trunk",
      environment: "testing",
      mediaEncryption: "required",
      storeSipMessages: false,
      outboundTrunkAllowed: false,
    },
    reconciliation: {
      defaultMode: "plan",
      expectedBaseDigestRequiredForApply: true,
      maximumPages: 100,
      pageSize: 20,
      requestTimeoutMs: 15_000,
      blindMutationRetries: 0,
    },
    deployment: {
      testNumberOnly: true,
      explicitNumberRoutingFlagRequired: true,
      allowProductionTraffic: false,
      allowOutboundCalls: false,
      allowNumberPurchase: false,
      allowNumberRelease: false,
      allowDelete: false,
      plivoRecordingEnabled: false,
      plivoTranscriptionEnabled: false,
    },
  });
