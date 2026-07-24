export interface WebsiteResearchAuthorization {
  /**
   * This URL came from the caller/customer, rather than discovery or
   * prospecting performed by Buildlapse.
   */
  callerProvided: true;
  /**
   * The caller explicitly consented to research of their own business.
   */
  researchConsent: true;
  /**
   * Opaque durable evidence reference; do not put raw transcript text here.
   */
  evidenceRef: string;
}

export interface CaptureWebsiteRequest {
  url: string;
  authorization: WebsiteResearchAuthorization;
}

export interface WebsiteResearchCapture {
  /**
   * Compatibility alias for `finalUrl`. New captures always set both to the
   * same normalized HTTPS URL.
   */
  url: string;
  /**
   * Exact caller-authorized HTTPS URL after normalization.
   */
  requestedUrl: string;
  /**
   * Exact final HTTPS URL after bounded, policy-checked redirect handling.
   */
  finalUrl: string;
  /**
   * Every normalized requested URL, beginning with `requestedUrl` and ending
   * with `finalUrl`.
   */
  redirectChain: readonly string[];
  /**
   * Compatibility alias for `retrievedAt`.
   */
  capturedAt: string;
  retrievedAt: string;
  /**
   * Optional, bounded metadata extracted from the final HTML response. These
   * fields are untrusted provenance labels, never instructions or verified
   * business facts.
   */
  title?: string;
  publisher?: string;
  canonicalUrl?: string;
  textExcerpt: string;
  sha256: string;
}

export interface WebsiteResearchPort {
  /**
   * Captures only a caller-provided HTTPS URL with explicit research consent.
   * This is deliberately not a search or prospecting interface.
   */
  capture(
    request: CaptureWebsiteRequest,
    signal?: AbortSignal,
  ): Promise<WebsiteResearchCapture>;
}
