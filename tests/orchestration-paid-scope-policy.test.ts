import { describe, expect, it } from "vitest";

import {
  assertPaidRevisionUsesExactCommercialScope,
  customerChangeRequiresRequote,
  UnpaidScopeExpansionError,
} from "../src/orchestration/application/paid-scope-policy.js";

describe("paid-scope policy", () => {
  const paidScope = {
    deliverables: [
      {
        itemId: "website",
        text: "Build Mission Peak Electric a site.",
      },
    ],
    requirements: [
      {
        requirementId: "homepage",
        description: "Build Mission Peak Electric a site.",
      },
    ],
  };

  it.each([
    "Add ecommerce checkout.",
    "Please integrate the site with Salesforce.",
    "The site should include customer accounts.",
    "Can it take cards?",
    "Could users sign in?",
    "Make appointments possible.",
    "Remove login and add ecommerce checkout.",
    "Make the CTA blue and add customer accounts.",
    "Make the button launch live chat blue.",
    "Make the button send data externally blue.",
  ])("forces a re-quote for an unpurchased addition: %s", (customerChange) => {
    expect(customerChangeRequiresRequote(paidScope, customerChange)).toBe(true);
  });

  it.each([
    "Please make the call to action blue.",
    "Update the headline wording.",
    "Remove the secondary button.",
    "Thanks, looks good.",
    "Build Mission Peak Electric a site.",
  ])(
    "permits only bounded edits or exact paid evidence without a re-quote: %s",
    (customerChange) => {
      expect(customerChangeRequiresRequote(paidScope, customerChange)).toBe(
        false,
      );
    },
  );

  it("rejects a Fireworks plan that adds a requirement despite an in-scope label", () => {
    expect(assertPaidRevisionUsesExactCommercialScope).toBeTypeOf("function");
    expect(UnpaidScopeExpansionError).toBeTypeOf("function");
    expect(() =>
      assertPaidRevisionUsesExactCommercialScope(
        paidScope,
        {
          scopeItems: [
            {
              id: "website",
              text: "Build Mission Peak Electric a site.",
            },
          ],
          requirements: [
            {
              id: "homepage",
              description: "Build Mission Peak Electric a site.",
            },
            {
              id: "salesforce",
              description: "Integrate Salesforce CRM.",
            },
          ],
        },
        "Please integrate the site with Salesforce.",
      ),
    ).toThrow(UnpaidScopeExpansionError);
  });

  it("allows an exact-evidence change backed by rendered HTTP proof", () => {
    const customerChange = "Please make the call to action blue.";
    expect(() =>
      assertPaidRevisionUsesExactCommercialScope(
        paidScope,
        {
          scopeItems: [
            {
              id: "website",
              text: "Build Mission Peak Electric a site.",
            },
          ],
          requirements: [
            {
              id: "homepage",
              description: "Build Mission Peak Electric a site.",
            },
            {
              id: "change-cta-blue",
              description: customerChange,
              citation: {
                kind: "conversation",
                excerpt: customerChange,
              },
              priority: "hard",
              verifiers: [
                {
                  kind: "http",
                  bodyIncludes: [customerChange],
                },
              ],
            },
          ],
        },
        customerChange,
      ),
    ).not.toThrow();
  });

  it("rejects a bounded change brief that cannot hard-block proof", () => {
    const customerChange = "Please make the call to action blue.";
    expect(() =>
      assertPaidRevisionUsesExactCommercialScope(
        paidScope,
        {
          scopeItems: [
            {
              id: "website",
              text: "Build Mission Peak Electric a site.",
            },
          ],
          requirements: [
            {
              id: "homepage",
              description: "Build Mission Peak Electric a site.",
            },
            {
              id: "change-cta-blue",
              description: customerChange,
              citation: {
                kind: "conversation",
                excerpt: customerChange,
              },
              priority: "preference",
              verifiers: [],
            },
          ],
        },
        customerChange,
      ),
    ).toThrow(UnpaidScopeExpansionError);
  });
});
