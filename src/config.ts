import { z } from "zod";

const SecureServiceUrlSchema = z.url().refine(
  (value) => {
    const url = new URL(value);
    const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && loopbackHosts.has(url.hostname))) &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  },
  {
    message:
      "Provider URL must use HTTPS, except for loopback HTTP, and must not contain credentials, query, or fragment",
  },
);

const ConfigSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
    BUILDLABS_DATABASE_PATH: z
      .string()
      .min(1)
      .default(".buildlabs/build-agent.db"),
    BUILDLABS_ARTIFACT_DIR: z.string().min(1).default(".buildlabs/artifacts"),
    BUILDLABS_INTERNAL_TOKEN: z.string().min(32).optional(),
    BUILDLABS_SLOT_COUNT: z.coerce.number().int().min(1).max(4).default(4),
    BUILDLABS_LEASE_MILLISECONDS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(300_000)
      .default(30_000),
    DAYTONA_API_KEY: z.string().min(20),
    DAYTONA_API_URL: SecureServiceUrlSchema.default(
      "https://app.daytona.io/api",
    ),
    DAYTONA_TARGET: z.string().min(1).optional(),
    DAYTONA_BUILD_SNAPSHOT: z
      .string()
      .min(1)
      .max(256)
      .default("buildlabs-dind-browser-v2"),
    DAYTONA_SNAPSHOT_ATTESTATION_PATH: z
      .string()
      .min(1)
      .default(".buildlabs/daytona/snapshot-attestation.json"),
    DAYTONA_PROVISIONER_SOURCE_PATH: z
      .string()
      .min(1)
      .default("scripts/provision-daytona-snapshot.ts"),
    DAYTONA_TELEMETRY_PATH: z
      .string()
      .min(1)
      .default(".buildlabs/daytona/telemetry.jsonl"),
    DAYTONA_WARM_POOL_ROLES: z.string().default(""),
    DAYTONA_OTEL_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    DAYTONA_OTEL_SAFE_POLICY_ATTESTATION: z.string().min(1).optional(),
    FIREWORKS_API_KEY: z.string().min(20),
    FIREWORKS_BASE_URL: SecureServiceUrlSchema.default(
      "https://api.fireworks.ai/inference/v1",
    ),
    FIREWORKS_MODEL: z
      .string()
      .min(1)
      .default("accounts/fireworks/models/glm-5p2"),
    FIREWORKS_BUILDER_MODEL: z.string().min(1).optional(),
    FIREWORKS_STUDIO_MODEL: z
      .string()
      .min(1)
      .default("accounts/fireworks/models/kimi-k2p6"),
    FIREWORKS_EVALUATOR_MODEL: z.string().min(1).optional(),
    FIREWORKS_VISION_MODEL: z
      .string()
      .min(1)
      .default("accounts/fireworks/models/kimi-k2p6"),
    BRAINTRUST_API_KEY: z.string().min(20),
    BRAINTRUST_API_URL: SecureServiceUrlSchema.default(
      "https://api.braintrust.dev",
    ),
    BRAINTRUST_APP_URL: SecureServiceUrlSchema.default(
      "https://www.braintrust.dev",
    ),
    BRAINTRUST_PROJECT_NAME: z.string().min(1).default("BuildLabs"),
    ELEVENLABS_API_KEY: z.string().min(20).optional(),
    ELEVENLABS_SPEECH_ENGINE_ID: z
      .string()
      .regex(/^(?:seng|agent)_[A-Za-z0-9_-]+$/)
      .optional(),
    ELEVENLABS_TOOL_SECRET: z.string().min(32).optional(),
    ELEVENLABS_CAPABILITY_SECRET: z.string().min(32).optional(),
    CODERABBIT_AUTH_MODE: z
      .enum(["oauth", "preauthenticated"])
      .default("preauthenticated"),
    CODERABBIT_AUTH_HOME: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).max(4_096).optional(),
    ),
    CODERABBIT_BIN: z.string().min(1).default("coderabbit"),
    CODERABBIT_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(1_800)
      .default(600),
  })
  .superRefine((config, context) => {
    const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
    if (
      config.NODE_ENV === "production" &&
      config.BUILDLABS_DATABASE_PATH === ":memory:"
    ) {
      context.addIssue({
        code: "custom",
        message: "Production build state requires durable SQLite storage",
        path: ["BUILDLABS_DATABASE_PATH"],
      });
    }
    if (
      (config.NODE_ENV === "production" || !loopbackHosts.has(config.HOST)) &&
      !config.BUILDLABS_INTERNAL_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        message:
          "BUILDLABS_INTERNAL_TOKEN is required in production or on a non-loopback host",
        path: ["BUILDLABS_INTERNAL_TOKEN"],
      });
    }
    if (
      config.CODERABBIT_AUTH_MODE === "preauthenticated" &&
      !config.CODERABBIT_AUTH_HOME
    ) {
      context.addIssue({
        code: "custom",
        message:
          "CODERABBIT_AUTH_HOME is required when CODERABBIT_AUTH_MODE=preauthenticated",
        path: ["CODERABBIT_AUTH_HOME"],
      });
    }
    if (config.ELEVENLABS_SPEECH_ENGINE_ID && !config.ELEVENLABS_API_KEY) {
      context.addIssue({
        code: "custom",
        message:
          "ELEVENLABS_API_KEY is required when ELEVENLABS_SPEECH_ENGINE_ID is configured",
        path: ["ELEVENLABS_API_KEY"],
      });
    }
    if (config.ELEVENLABS_TOOL_SECRET && !config.ELEVENLABS_CAPABILITY_SECRET) {
      context.addIssue({
        code: "custom",
        message:
          "ELEVENLABS_CAPABILITY_SECRET is required when ELEVENLABS_TOOL_SECRET is configured",
        path: ["ELEVENLABS_CAPABILITY_SECRET"],
      });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return ConfigSchema.parse(environment);
}
