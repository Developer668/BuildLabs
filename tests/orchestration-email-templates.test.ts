import { describe, expect, it } from "vitest";

import {
  customerDashboardLoginEmail,
  dashboardAccessEmail,
  emailVerificationEmail,
  paymentConfirmationEmail,
  proposalEmail,
  provenPreviewEmail,
  productionDeliveryEmail,
} from "../src/orchestration/application/customer-email-templates.js";

describe("customer orchestration email templates", () => {
  it("uses passwordless project-bound links without echoing dictated contact details", () => {
    const verification = emailVerificationEmail({
      customerName: "Jordan",
      verificationUrl:
        "https://orchestrator.buildlabs.example/v1/orchestration/customer-dashboard/access#token=login.v1.signed",
      replyTo: "project+opaque@example.com",
    });
    expect(verification.text).toContain("passwordless");
    expect(verification.text).toContain(
      "/customer-dashboard/access#token=login.v1.",
    );

    const dashboard = dashboardAccessEmail({
      customerName: "Jordan",
      projectTitle: "Mission Peak Electric website",
      dashboardUrl:
        "https://orchestrator.buildlabs.example/v1/orchestration/customer-dashboard/access#token=login.v1.signed",
      replyTo: "project+opaque@example.com",
    });
    expect(dashboard.text).toContain("build agents");
    expect(dashboard.text).toContain("live build activity");

    const reissue = customerDashboardLoginEmail({
      customerName: "Jordan",
      dashboardUrl:
        "https://orchestrator.buildlabs.example/v1/orchestration/customer-dashboard/access#token=login.v1.signed",
      emailVerified: true,
      replyTo: "project+opaque@example.com",
    });
    expect(reissue.subject).toContain("sign-in link");
    expect(reissue.text).not.toContain("build agents");

    const firstVerification = customerDashboardLoginEmail({
      dashboardUrl:
        "https://orchestrator.buildlabs.example/v1/orchestration/customer-dashboard/access#token=login.v1.signed",
      emailVerified: false,
      replyTo: "project+opaque@example.com",
    });
    expect(firstVerification.text).toContain("email captured for this project");
    expect(firstVerification.text).not.toContain("verified email");
  });

  it("sends a version-bound summary, quote, payment link, and reply instructions", () => {
    const message = proposalEmail({
      customerName: "Jordan",
      projectTitle: "Mission Peak Electric website",
      proposalVersion: 2,
      proposalDigest: "a".repeat(64),
      summary: "A responsive service website with an estimate request flow.",
      scopeItems: ["Homepage", "Estimate form"],
      hardRequirements: ["The homepage and estimate form must load."],
      preferences: ["Use the approved visual direction."],
      supportedFacts: ["Mission Peak Electric (source: caller conversation)"],
      exclusions: ["Do not claim 24/7 service."],
      unknowns: [],
      verificationSummary:
        "build, tests, hard contract checks, and unsupported-claim scan",
      amountMinor: 250_000,
      currency: "usd",
      checkoutUrl: "https://checkout.stripe.com/c/pay/test",
      replyTo: "project+opaque@example.com",
    });

    expect(message.subject).toContain("v2");
    expect(message.text).toContain("$2,500.00");
    expect(message.text).toContain("https://checkout.stripe.com/c/pay/test");
    expect(message.text).toContain("Hard acceptance requirements");
    expect(message.text).toContain("Do not claim 24/7 service.");
    expect(message.text).toContain("a".repeat(64));
    expect(message.text).toContain("Payment confirms approval");
    expect(message.text).toContain("reply");
  });

  it("clearly sequences payment, proven preview, steering, and final delivery", () => {
    const confirmation = paymentConfirmationEmail({
      customerName: "Jordan",
      projectTitle: "Mission Peak Electric website",
      proposalVersion: 2,
      replyTo: "project+opaque@example.com",
    });
    expect(confirmation.text).toContain("payment");
    expect(confirmation.text).toContain("proven preview");

    const preview = provenPreviewEmail({
      customerName: "Jordan",
      projectTitle: "Mission Peak Electric website",
      contractVersion: 3,
      previewUrl: "https://preview.example.com/frozen",
      proofSummary:
        "Build, tests, contract, and unsupported-claim checks passed.",
      replyTo: "project+opaque@example.com",
    });
    expect(preview.text).toContain("frozen");
    expect(preview.text).toContain("reply");

    const final = productionDeliveryEmail({
      customerName: "Jordan",
      projectTitle: "Mission Peak Electric website",
      contractVersion: 3,
      productionUrl: "https://mission-peak.fly.dev",
      proofSummary: "All declared hard checks passed.",
      proofSummaryUrl:
        "https://orchestrator.buildlabs.example/v1/orchestration/proof-summaries/signed-capability",
      replyTo: "project+opaque@example.com",
    });
    expect(final.text).toContain("https://mission-peak.fly.dev");
    expect(final.text).toContain(
      "https://orchestrator.buildlabs.example/v1/orchestration/proof-summaries/signed-capability",
    );
    expect(final.text).toMatch(/recorded proof summary/i);
    expect(final.text).toContain("production");
  });
});
