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
    BUILDLAPSE_DATABASE_PATH: z
      .string()
      .min(1)
      .default(".buildlapse/build-agent.db"),
    BUILDLAPSE_ARTIFACT_DIR: z.string().min(1).default(".buildlapse/artifacts"),
    BUILDLAPSE_INTERNAL_TOKEN: z.string().min(32).optional(),
    BUILDLAPSE_SLOT_COUNT: z.coerce.number().int().min(1).max(4).default(4),
    BUILDLAPSE_LEASE_MILLISECONDS: z.coerce
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
      .default("buildlapse-dind-browser-v2"),
    DAYTONA_OTEL_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    FIREWORKS_API_KEY: z.string().min(20),
    FIREWORKS_BASE_URL: SecureServiceUrlSchema.default(
      "https://api.fireworks.ai/inference/v1",
    ),
    FIREWORKS_MODEL: z
      .string()
      .min(1)
      .default("accounts/fireworks/models/kimi-k2p7-code"),
    FIREWORKS_BUILDER_MODEL: z.string().min(1).optional(),
    FIREWORKS_STUDIO_MODEL: z
      .string()
      .min(1)
      .default("accounts/fireworks/routers/kimi-k2p6-turbo"),
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
    BRAINTRUST_PROJECT_NAME: z.string().min(1).default("Buildlapse"),
    ELEVENLABS_API_KEY: z.string().min(20).optional(),
    ELEVENLABS_SPEECH_ENGINE_ID: z
      .string()
      .regex(/^(?:seng|agent)_[A-Za-z0-9_-]+$/)
      .optional(),
    ELEVENLABS_TOOL_SECRET: z.string().min(32).optional(),
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
      config.BUILDLAPSE_DATABASE_PATH === ":memory:"
    ) {
      context.addIssue({
        code: "custom",
        message: "Production build state requires durable SQLite storage",
        path: ["BUILDLAPSE_DATABASE_PATH"],
      });
    }
    if (
      (config.NODE_ENV === "production" || !loopbackHosts.has(config.HOST)) &&
      !config.BUILDLAPSE_INTERNAL_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        message:
          "BUILDLAPSE_INTERNAL_TOKEN is required in production or on a non-loopback host",
        path: ["BUILDLAPSE_INTERNAL_TOKEN"],
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
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return ConfigSchema.parse(environment);
}
