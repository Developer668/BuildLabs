export interface ResearchAuthorizationEvidence {
  url: string;
  consentEvidenceExcerpt: string;
}

export class UnverifiedResearchAuthorizationError extends Error {
  constructor() {
    super(
      "Research requires one exact, standalone, positive caller-consent sentence naming the URL and the caller's ownership or authority for that business",
    );
    this.name = "UnverifiedResearchAuthorizationError";
  }
}

/**
 * Fireworks may identify a research target, but only deterministic evidence
 * authorizes network access. Ambiguous, conditional, or negative wording fails
 * closed and must return to customer clarification.
 */
export function assertExplicitResearchAuthorization(
  minimizedConversation: string,
  target: ResearchAuthorizationEvidence,
): void {
  const excerpt = target.consentEvidenceExcerpt.trim();
  const hasExactEvidenceLine = minimizedConversation
    .split(/\r?\n/u)
    .some((line) => line.trim() === excerpt);
  let hostname: string;
  try {
    hostname = new URL(target.url).hostname.toLocaleLowerCase();
  } catch {
    throw new UnverifiedResearchAuthorizationError();
  }
  const normalized = excerpt.toLocaleLowerCase();
  const hasTarget =
    normalized.includes(hostname) ||
    normalized.includes(target.url.toLocaleLowerCase());
  const mentionedHttpsUrls = [...excerpt.matchAll(/https:\/\/[^\s<>"']+/giu)]
    .map((match) => match[0].replace(/[),.;!?]+$/u, ""))
    .map((value) => {
      try {
        return new URL(value);
      } catch {
        return undefined;
      }
    })
    .filter((value): value is URL => value !== undefined);
  const hasOneExactTargetUrl =
    mentionedHttpsUrls.length === 1 &&
    mentionedHttpsUrls[0]?.hostname.toLocaleLowerCase() === hostname;
  const hasPositiveAuthorization =
    /\b(?:i\s+(?:consent|authorize|approve|agree)|please|you\s+(?:may|can|are\s+allowed\s+to)|feel\s+free\s+to)\b.{0,120}\b(?:research|review|check|visit|look\s+up|use|inspect|take\s+inspiration\s+from)\b/u.test(
      normalized,
    ) ||
    /\b(?:research|review|check|visit|look\s+up|use|inspect|take\s+inspiration\s+from)\b.{0,120}\b(?:is\s+(?:approved|authorized|allowed)|with\s+my\s+(?:consent|permission))\b/u.test(
      normalized,
    );
  const hasOwnBusinessAuthority =
    /\b(?:my|our)\s+(?:(?:business|company|organization)(?:'s)?\s+)?(?:website|site|domain)\b/u.test(
      normalized,
    ) ||
    /\b(?:my|our)\s+(?:business|company|organization)\b/u.test(normalized) ||
    /\b(?:i|we)\s+(?:own|operate|run|manage|control|represent)\b/u.test(
      normalized,
    ) ||
    /\b(?:i\s+am|we\s+are)\s+authori[sz]ed\s+to\s+(?:act\s+for|represent|manage|control)\b/u.test(
      normalized,
    );
  const hasBlockingLanguage =
    /\b(?:do\s+not|don't|dont|not|never|no|without|revoke|stop|cannot|can't|cant|shouldn't|shouldnt|might|maybe|considering|if)\b/u.test(
      normalized,
    );

  if (
    excerpt.length === 0 ||
    !hasExactEvidenceLine ||
    !hasTarget ||
    !hasOneExactTargetUrl ||
    !hasPositiveAuthorization ||
    !hasOwnBusinessAuthority ||
    hasBlockingLanguage
  ) {
    throw new UnverifiedResearchAuthorizationError();
  }
}
