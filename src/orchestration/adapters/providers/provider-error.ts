export type ProviderErrorCode =
  | "INVALID_INPUT"
  | "INVALID_PROVIDER_RESPONSE"
  | "INVALID_WEBHOOK"
  | "POLICY_BLOCKED"
  | "PROVIDER_FAILURE";

/**
 * Deliberately carries no upstream error message or request value. Provider
 * errors can contain credentials, PII, or signed payload fragments.
 */
export class ProviderAdapterError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: "research" | "resend" | "stripe";
  readonly operation: string;

  constructor(
    provider: ProviderAdapterError["provider"],
    operation: string,
    code: ProviderErrorCode,
  ) {
    super(`${provider} ${operation} failed (${code})`);
    this.name = "ProviderAdapterError";
    this.provider = provider;
    this.operation = operation;
    this.code = code;
  }
}
