import { z } from "zod";

import { redactText } from "./redaction.js";

const MAX_ISSUES = 64;
const MIN_SCRUBBED_VALUE_LENGTH = 8;

/**
 * Summarizes a configuration validation failure as key names and constraint
 * messages so an operator can see *which* variables are wrong.
 *
 * Configuration input is secret-bearing, so the rejected value must never
 * appear in the output. Key names are not secret; values are. Every message is
 * scrubbed against the environment that was validated, then run through the
 * shared redactor, so a provider token pasted into the wrong variable cannot
 * escape into logs even if a future schema quotes its input.
 */
export function describeConfigIssues(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!(error instanceof z.ZodError)) {
    return [];
  }
  const secrets = scrubbableValues(environment);
  return error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${key}: ${scrub(issue.message, secrets)}`;
  });
}

/**
 * Renders the issues as a single operator-facing block. Returns undefined when
 * the failure is not a schema rejection, so callers keep their generic path.
 */
export function formatConfigFailure(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const issues = describeConfigIssues(error, environment);
  if (issues.length === 0) {
    return undefined;
  }
  const heading =
    issues.length === 1
      ? "1 configuration variable is missing or invalid:"
      : `${issues.length} configuration variables are missing or invalid:`;
  return [heading, ...issues.map((issue) => `  - ${issue}`)].join("\n");
}

function scrubbableValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.values(environment)
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length >= MIN_SCRUBBED_VALUE_LENGTH,
    )
    .sort((left, right) => right.length - left.length);
}

function scrub(message: string, secrets: string[]): string {
  let scrubbed = message;
  for (const secret of secrets) {
    if (scrubbed.includes(secret)) {
      scrubbed = scrubbed.split(secret).join("[REDACTED]");
    }
  }
  return redactText(scrubbed);
}
