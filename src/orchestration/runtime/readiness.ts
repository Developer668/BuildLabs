import type { ModelPort } from "../../ports/index.js";
import type { OrchestrationReadinessResult } from "../http/server.js";
import type { BuildBackendPort } from "../ports/build-backend.js";
import type { FlyDeploymentPort } from "../ports/deployment.js";
import type { MailPort } from "../ports/mail.js";
import type { PaymentPort } from "../ports/payment.js";
import type { OrchestrationTracePort } from "../ports/trace.js";
import type { ReconciliationProjectIndex } from "./reconciliation-worker.js";

const DEFAULT_TIMEOUT_MILLISECONDS = 20_000;
const DEFAULT_CACHE_MILLISECONDS = 30_000;

export interface OrchestrationReadinessProbeOptions {
  index: ReconciliationProjectIndex;
  model: Pick<ModelPort, "health">;
  trace: Pick<OrchestrationTracePort, "health">;
  payment: Pick<PaymentPort, "health">;
  mail: Pick<MailPort, "health">;
  buildBackend: Pick<BuildBackendPort, "health">;
  deployment: Pick<FlyDeploymentPort, "health">;
  timeoutMilliseconds?: number;
  cacheMilliseconds?: number;
  now?: () => number;
}

/**
 * Probes every production dependency with real, read-only provider calls.
 * Results are briefly cached so a readiness poll cannot amplify provider load.
 */
export function createOrchestrationReadinessProbe(
  options: OrchestrationReadinessProbeOptions,
): () => Promise<OrchestrationReadinessResult> {
  const timeoutMilliseconds = validateDuration(
    options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
    100,
    30_000,
    "Readiness timeout",
  );
  const cacheMilliseconds = validateDuration(
    options.cacheMilliseconds ?? DEFAULT_CACHE_MILLISECONDS,
    0,
    5 * 60_000,
    "Readiness cache duration",
  );
  const now = options.now ?? Date.now;
  let cache:
    | {
        expiresAt: number;
        result: Promise<OrchestrationReadinessResult>;
      }
    | undefined;

  return () => {
    const currentTime = now();
    if (cache && currentTime < cache.expiresAt) {
      return cache.result;
    }
    const result = runChecks(options, timeoutMilliseconds);
    cache = {
      expiresAt: currentTime + cacheMilliseconds,
      result,
    };
    return result;
  };
}

async function runChecks(
  options: OrchestrationReadinessProbeOptions,
  timeoutMilliseconds: number,
): Promise<OrchestrationReadinessResult> {
  const signal = AbortSignal.timeout(timeoutMilliseconds);
  const results = await Promise.allSettled([
    boundedHealthCheck(() => {
      options.index.listProjectIdsForReconciliation(1);
      return Promise.resolve();
    }, signal),
    boundedHealthCheck(
      (healthSignal) => options.model.health(healthSignal),
      signal,
    ),
    boundedHealthCheck(
      (healthSignal) => options.trace.health(healthSignal),
      signal,
    ),
    boundedHealthCheck(
      (healthSignal) => options.payment.health(healthSignal),
      signal,
    ),
    boundedHealthCheck(
      (healthSignal) => options.mail.health(healthSignal),
      signal,
    ),
    boundedHealthCheck(
      (healthSignal) => options.buildBackend.health(healthSignal),
      signal,
    ),
    boundedHealthCheck(
      (healthSignal) => options.deployment.health(healthSignal),
      signal,
    ),
  ]);
  return {
    database: isFulfilled(results[0]),
    fireworks: isFulfilled(results[1]),
    braintrust: isFulfilled(results[2]),
    stripe: isFulfilled(results[3]),
    resend: isFulfilled(results[4]),
    buildBackend: isFulfilled(results[5]),
    fly: isFulfilled(results[6]),
  };
}

async function boundedHealthCheck(
  operation: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new Error("Readiness deadline exceeded");
  }
  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => {
      reject(new Error("Readiness deadline exceeded"));
    };
    signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => operation(signal)),
      aborted,
    ]);
  } finally {
    if (rejectOnAbort) {
      signal.removeEventListener("abort", rejectOnAbort);
    }
  }
}

function isFulfilled(result: PromiseSettledResult<void> | undefined): boolean {
  return result?.status === "fulfilled";
}

function validateDuration(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}
