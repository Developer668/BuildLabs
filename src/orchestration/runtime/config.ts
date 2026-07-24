import { isIP } from "node:net";

import { z } from "zod";

const SecretSchema = z
  .string()
  .min(16)
  .max(8_192)
  .refine((value) => value.trim() === value && !hasControlCharacters(value), {
    message:
      "Secret must not contain surrounding whitespace or control characters",
  });
const HttpsUrlSchema = z.url().refine(
  (value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  },
  {
    message: "URL must use HTTPS and must not contain credentials",
  },
);
const HttpsBaseUrlSchema = HttpsUrlSchema.refine(
  (value) => {
    const url = new URL(value);
    return url.search.length === 0 && url.hash.length === 0;
  },
  {
    message: "Base URL must not contain a query string or fragment",
  },
);
/**
 * Plaintext HTTP is allowed only where the transport cannot leave the host or
 * the private network: a loopback address, or a provider-private hostname such
 * as Fly.io's `*.internal` 6PN names. Everything reachable from the public
 * internet must be HTTPS.
 */
export function isPrivateServiceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    new Set(["127.0.0.1", "::1", "[::1]", "localhost"]).has(host) ||
    host === "internal" ||
    host.endsWith(".internal")
  );
}

const SecureServiceUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "https:" ||
      (url.protocol === "http:" && isPrivateServiceHost(url.hostname))) &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
}, "Service URL must use HTTPS, except for a loopback or private (.internal) host");
const BooleanEnvironmentSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const EncryptionKeySchema = base64BufferSchema("encryption key", 32, 32);
const ReplySecretSchema = base64BufferSchema("reply secret", 32, 1_024);
const OptionalPathSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).max(4_096).optional(),
);

const OrchestrationConfigSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    ORCHESTRATION_HOST: z.string().min(1).max(255).default("127.0.0.1"),
    ORCHESTRATION_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(3_100),
    ORCHESTRATION_DATABASE_PATH: z
      .string()
      .min(1)
      .max(4_096)
      .default(".buildlabs/orchestration.db"),
    ORCHESTRATION_ENCRYPTION_KEY_BASE64: EncryptionKeySchema,
    ORCHESTRATION_INTERNAL_TOKEN: SecretSchema.min(32),
    ORCHESTRATION_REPLY_DOMAIN: z
      .string()
      .min(4)
      .max(253)
      .transform((value) => value.toLowerCase()),
    ORCHESTRATION_REPLY_SECRET_BASE64: ReplySecretSchema,
    ORCHESTRATION_FROM_EMAIL: z
      .string()
      .min(3)
      .max(998)
      .refine((value) => isValidSenderHeader(value), {
        message: "Sender must be an email address or Name <email> header",
      }),
    ORCHESTRATION_PUBLIC_BASE_URL: HttpsBaseUrlSchema,
    // Public origin of the customer dashboard. Emailed login capabilities land
    // here, not on this service: the dashboard owns the customer session cookie
    // and the opaque project alias. Defaults to the orchestrator's own origin
    // only so a single-origin deployment behind one proxy still works.
    ORCHESTRATION_DASHBOARD_BASE_URL: HttpsBaseUrlSchema.optional(),
    ORCHESTRATION_RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(5 * 60_000)
      .default(10_000),
    ORCHESTRATION_RECONCILE_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(25),
    ORCHESTRATION_RECONCILE_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(32)
      .default(4),
    ORCHESTRATION_PROJECT_RECONCILE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10 * 60_000 + 1_000)
      .max(90 * 60_000)
      .default(32 * 60_000),
    ORCHESTRATION_TRACE_FLUSH_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(10_000),
    ORCHESTRATION_EFFECT_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5),
    ORCHESTRATION_EFFECT_RETRY_INITIAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(5 * 60_000)
      .default(1_000),
    ORCHESTRATION_EFFECT_RETRY_MAX_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(24 * 60 * 60 * 1_000)
      .default(60_000),
    ORCHESTRATION_BUILD_DEADLINE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1_000)
      .default(2 * 60 * 60 * 1_000),
    ORCHESTRATION_PROOF_EVENT_GRACE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(30 * 60 * 1_000)
      .default(2 * 60 * 1_000),
    ORCHESTRATION_MAIL_DELIVERY_DEADLINE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(7 * 24 * 60 * 60 * 1_000)
      .default(6 * 60 * 60 * 1_000),
    ORCHESTRATION_SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    ORCHESTRATION_PREVIEW_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 60 * 60)
      .default(48 * 60 * 60),
    ORCHESTRATION_PREVIEW_REVIEW_PERIOD_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(6 * 24 * 60 * 60 * 1_000)
      .default(24 * 60 * 60 * 1_000),
    ORCHESTRATION_ARTIFACT_TEMP_DIRECTORY: OptionalPathSchema,
    FIREWORKS_API_KEY: SecretSchema,
    FIREWORKS_BASE_URL: HttpsBaseUrlSchema.default(
      "https://api.fireworks.ai/inference/v1",
    ),
    FIREWORKS_MODEL: z
      .string()
      .min(1)
      .max(512)
      .default("accounts/fireworks/models/minimax-m3"),
    BRAINTRUST_API_KEY: SecretSchema,
    BRAINTRUST_API_URL: HttpsBaseUrlSchema.default(
      "https://api.braintrust.dev",
    ),
    BRAINTRUST_APP_URL: HttpsBaseUrlSchema.default(
      "https://www.braintrust.dev",
    ),
    BRAINTRUST_PROJECT_NAME: z.string().min(1).max(512).default("BuildLabs"),
    STRIPE_SECRET_KEY: SecretSchema,
    STRIPE_WEBHOOK_SECRET: SecretSchema,
    STRIPE_SUCCESS_URL: HttpsUrlSchema,
    STRIPE_CANCEL_URL: HttpsUrlSchema,
    STRIPE_EXPECTED_LIVEMODE: BooleanEnvironmentSchema,
    STRIPE_PRODUCT_NAME: z
      .string()
      .min(1)
      .max(250)
      .default("BuildLabs software engagement"),
    RESEND_API_KEY: SecretSchema,
    RESEND_WEBHOOK_SECRET: SecretSchema,
    BUILD_BACKEND_BASE_URL: SecureServiceUrlSchema.default(
      "http://127.0.0.1:3000",
    ),
    BUILD_BACKEND_INTERNAL_TOKEN: SecretSchema,
    BUILD_BACKEND_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30 * 60_000)
      .default(30_000),
    BUILD_BACKEND_PREVIEW_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(120_000)
      .max(30 * 60_000)
      .default(6 * 60_000),
    BUILD_BACKEND_ARTIFACT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(120_000)
      .max(30 * 60_000)
      .default(10 * 60_000),
    FLY_ACCESS_TOKEN: SecretSchema,
    FLY_ORG_SLUG: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
    FLY_PRIMARY_REGION: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
    FLY_APP_NAME_PREFIX: z
      .string()
      .min(1)
      .max(24)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .default("buildlabs"),
    FLYCTL_BIN: z.string().min(1).max(1_024).default("flyctl"),
    FLY_HEALTH_PATH: z
      .string()
      .min(1)
      .max(2_048)
      .regex(/^\/[^?#]*$/)
      .default("/"),
    FLY_OPERATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10 * 60_000)
      .max(30 * 60_000)
      .default(20 * 60_000),
    DAYTONA_BUILD_SNAPSHOT: z
      .string()
      .min(1)
      .max(256)
      .default("buildlabs-dind-v1"),
  })
  .superRefine((config, context) => {
    if (
      config.NODE_ENV === "production" &&
      config.ORCHESTRATION_DATABASE_PATH === ":memory:"
    ) {
      context.addIssue({
        code: "custom",
        path: ["ORCHESTRATION_DATABASE_PATH"],
        message: "Production orchestration requires durable SQLite storage",
      });
    }
    if (
      config.ORCHESTRATION_ENCRYPTION_KEY_BASE64.byteLength ===
        config.ORCHESTRATION_REPLY_SECRET_BASE64.byteLength &&
      config.ORCHESTRATION_ENCRYPTION_KEY_BASE64.equals(
        config.ORCHESTRATION_REPLY_SECRET_BASE64,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["ORCHESTRATION_REPLY_SECRET_BASE64"],
        message: "State encryption and reply-address keys must be independent",
      });
    }
    if (
      config.ORCHESTRATION_INTERNAL_TOKEN ===
      config.BUILD_BACKEND_INTERNAL_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        path: ["BUILD_BACKEND_INTERNAL_TOKEN"],
        message: "Orchestrator and build-backend tokens must be distinct",
      });
    }
    if (
      config.ORCHESTRATION_RECONCILE_CONCURRENCY >
      config.ORCHESTRATION_RECONCILE_BATCH_SIZE
    ) {
      context.addIssue({
        code: "custom",
        path: ["ORCHESTRATION_RECONCILE_CONCURRENCY"],
        message: "Reconciliation concurrency cannot exceed batch size",
      });
    }
    if (
      config.ORCHESTRATION_PROJECT_RECONCILE_TIMEOUT_MS <=
      config.BUILD_BACKEND_ARTIFACT_TIMEOUT_MS +
        config.FLY_OPERATION_TIMEOUT_MS +
        config.ORCHESTRATION_TRACE_FLUSH_TIMEOUT_MS +
        60_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["ORCHESTRATION_PROJECT_RECONCILE_TIMEOUT_MS"],
        message:
          "Project reconciliation timeout must exceed artifact transfer, Fly deployment, trace flush, and a one-minute control margin",
      });
    }
    if (
      config.ORCHESTRATION_EFFECT_RETRY_MAX_MS <
      config.ORCHESTRATION_EFFECT_RETRY_INITIAL_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["ORCHESTRATION_EFFECT_RETRY_MAX_MS"],
        message:
          "Effect retry maximum delay cannot be shorter than its initial delay",
      });
    }
    if (
      config.ORCHESTRATION_PREVIEW_TTL_SECONDS * 1_000 <
      config.ORCHESTRATION_PREVIEW_REVIEW_PERIOD_MS + 60 * 60 * 1_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["ORCHESTRATION_PREVIEW_TTL_SECONDS"],
        message:
          "Preview TTL must exceed the review period by at least one hour",
      });
    }
    const keyMode = /^(?:sk|rk)_live_/.test(config.STRIPE_SECRET_KEY)
      ? true
      : /^(?:sk|rk)_test_/.test(config.STRIPE_SECRET_KEY)
        ? false
        : undefined;
    if (keyMode !== undefined && keyMode !== config.STRIPE_EXPECTED_LIVEMODE) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_EXPECTED_LIVEMODE"],
        message: "Stripe key mode does not match the explicitly expected mode",
      });
    }
    if (config.NODE_ENV === "production") {
      if (config.STRIPE_EXPECTED_LIVEMODE !== true || keyMode !== true) {
        context.addIssue({
          code: "custom",
          path: ["STRIPE_SECRET_KEY"],
          message:
            "Production orchestration requires a recognizable live-mode Stripe secret or restricted key",
        });
      }
      const customerHosts = [
        {
          path: ["ORCHESTRATION_REPLY_DOMAIN"],
          value: config.ORCHESTRATION_REPLY_DOMAIN,
        },
        {
          path: ["ORCHESTRATION_FROM_EMAIL"],
          value: senderDomain(config.ORCHESTRATION_FROM_EMAIL),
        },
        {
          path: ["STRIPE_SUCCESS_URL"],
          value: new URL(config.STRIPE_SUCCESS_URL).hostname,
        },
        {
          path: ["STRIPE_CANCEL_URL"],
          value: new URL(config.STRIPE_CANCEL_URL).hostname,
        },
        {
          path: ["ORCHESTRATION_PUBLIC_BASE_URL"],
          value: new URL(config.ORCHESTRATION_PUBLIC_BASE_URL).hostname,
        },
      ] as const;
      for (const host of customerHosts) {
        if (isReservedCustomerHost(host.value)) {
          context.addIssue({
            code: "custom",
            path: [...host.path],
            message:
              "Production customer-facing domains must be real routable domains, not reserved placeholders",
          });
        }
      }
    }
  });

export type OrchestrationConfig = z.infer<typeof OrchestrationConfigSchema>;

export function loadOrchestrationConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OrchestrationConfig {
  return OrchestrationConfigSchema.parse(environment);
}

export function assertOrchestrationNodeVersion(
  version = process.versions.node,
): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || major < 24) {
    throw new Error("The orchestration runtime requires Node.js 24 or newer");
  }
}

function base64BufferSchema(
  label: string,
  minimumBytes: number,
  maximumBytes: number,
) {
  return z.string().transform((value, context): Buffer => {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: `${label} must use canonical base64`,
      });
      return z.NEVER;
    }
    const decoded = Buffer.from(value, "base64");
    if (
      decoded.byteLength < minimumBytes ||
      decoded.byteLength > maximumBytes
    ) {
      context.addIssue({
        code: "custom",
        message: `${label} must decode to ${byteRange(minimumBytes, maximumBytes)}`,
      });
      return z.NEVER;
    }
    return decoded;
  });
}

function byteRange(minimum: number, maximum: number): string {
  return minimum === maximum
    ? `exactly ${minimum} bytes`
    : `${minimum}-${maximum} bytes`;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) {
      return true;
    }
  }
  return false;
}

function isValidSenderHeader(value: string): boolean {
  if (hasControlCharacters(value) || value.trim() !== value) {
    return false;
  }
  const displayMatch = /^.{1,900}<([^<>]+)>$/.exec(value);
  const address = (displayMatch?.[1] ?? value).trim();
  return z.email().max(320).safeParse(address).success;
}

function senderDomain(value: string): string {
  const displayMatch = /^.{1,900}<([^<>]+)>$/.exec(value);
  const address = (displayMatch?.[1] ?? value).trim();
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function isReservedCustomerHost(value: string): boolean {
  const host = value.toLowerCase().replace(/\.$/, "");
  return (
    isIP(host) !== 0 ||
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    host.endsWith(".arpa") ||
    host.endsWith(".onion") ||
    host === "example.com" ||
    host.endsWith(".example.com") ||
    host === "example.net" ||
    host.endsWith(".example.net") ||
    host === "example.org" ||
    host.endsWith(".example.org") ||
    host === "example" ||
    host.endsWith(".example") ||
    host === "invalid" ||
    host.endsWith(".invalid") ||
    host === "test" ||
    host.endsWith(".test")
  );
}
