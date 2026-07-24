export type BuildAdapterProvider = "build-backend" | "fly";

export type BuildAdapterErrorCode =
  | "ABORTED"
  | "ARTIFACT_INTEGRITY_FAILED"
  | "DEPLOYMENT_FAILED"
  | "HEALTH_CHECK_FAILED"
  | "INVALID_INPUT"
  | "INVALID_PROVIDER_RESPONSE"
  | "POLICY_BLOCKED"
  | "PROVIDER_FAILURE"
  | "RELEASE_FENCED"
  | "RELEASE_VERIFICATION_FAILED"
  | "UNSAFE_ARCHIVE";

/**
 * Provider output can contain bearer tokens, deploy credentials, customer data,
 * or generated source. Never attach upstream errors or response bodies.
 */
export class BuildAdapterError extends Error {
  readonly code: BuildAdapterErrorCode;
  readonly provider: BuildAdapterProvider;
  readonly operation: string;

  constructor(
    provider: BuildAdapterProvider,
    operation: string,
    code: BuildAdapterErrorCode,
  ) {
    super(`${provider} ${operation} failed (${code})`);
    this.name = "BuildAdapterError";
    this.provider = provider;
    this.operation = operation;
    this.code = code;
  }
}
