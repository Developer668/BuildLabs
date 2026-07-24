import { describe, expect, it } from "vitest";

import {
  CustomerProjectSnapshotSchema,
  parseCustomerProjectSnapshot,
} from "../lib/contracts/customer";
import { UnsafeProjectionError } from "../lib/contracts/safety";
import {
  customerProjectFixture,
  operatorProjectFixture,
} from "../lib/fixtures";
import { OperatorProjectSchema } from "../lib/contracts/operator";

describe("customer projection contracts", () => {
  it("accepts the deterministic four-builder fixture", () => {
    const parsed = CustomerProjectSnapshotSchema.parse(customerProjectFixture);
    expect(parsed.activeBatch?.builders).toHaveLength(4);
    expect(
      parsed.activeBatch?.builders.map((builder) => builder.status),
    ).toEqual(["running", "running", "running", "rejected"]);
    expect(parsed.requestedVersion).toBe(3);
    expect(parsed.currentProductionVersion).toBe(2);
  });

  it("rejects raw sandbox identifiers anywhere in the projection", () => {
    const injected = structuredClone(customerProjectFixture) as unknown as {
      activeBatch: {
        builders: Array<Record<string, unknown>>;
      };
    };
    injected.activeBatch.builders[0]!.sandboxId = "daytona-workspace-raw-123";

    expect(() => parseCustomerProjectSnapshot(injected)).toThrow(
      UnsafeProjectionError,
    );
  });

  it("rejects raw Daytona URLs even when nested under an unknown key", () => {
    const injected = {
      ...structuredClone(customerProjectFixture),
      activeBatch: {
        ...structuredClone(customerProjectFixture.activeBatch),
        builders: customerProjectFixture.activeBatch!.builders.map(
          (builder, index) =>
            index === 0
              ? {
                  ...builder,
                  workspace: {
                    ...builder.workspace,
                    daytonaUrl: "https://raw-workspace.daytona.example/session",
                  },
                }
              : builder,
        ),
      },
    };

    expect(() => parseCustomerProjectSnapshot(injected)).toThrow(
      UnsafeProjectionError,
    );
  });

  it("rejects markup, embedded URLs, credential shapes, and internal references", () => {
    for (const summary of [
      "<img src=x onerror=alert(1)>",
      "Open javascript:alert(1)",
      "Use Bearer abcdefghijklmnopqrstuvwxyz",
      "Inspect sandbox ID abc123",
    ]) {
      const injected = {
        ...structuredClone(customerProjectFixture),
        contract: {
          ...structuredClone(customerProjectFixture.contract),
          summary,
        },
      };
      expect(() => parseCustomerProjectSnapshot(injected)).toThrow(
        UnsafeProjectionError,
      );
    }
  });

  it("rejects a mutable or incomplete WIP frame receipt", () => {
    const injected = structuredClone(customerProjectFixture);
    const builder = injected.activeBatch!.builders[0]!;
    builder.workspace.customerRenderable = false;

    expect(() => parseCustomerProjectSnapshot(injected)).toThrow(
      UnsafeProjectionError,
    );
  });

  it("rejects preview and production digest or version mismatches", () => {
    const digestMismatch = structuredClone(customerProjectFixture);
    digestMismatch.production!.artifactDigest =
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    expect(() => parseCustomerProjectSnapshot(digestMismatch)).toThrow(
      UnsafeProjectionError,
    );

    const versionMismatch = structuredClone(customerProjectFixture);
    versionMismatch.currentProvenVersion = 3;
    expect(() => parseCustomerProjectSnapshot(versionMismatch)).toThrow(
      UnsafeProjectionError,
    );
  });

  it("rejects build activity that is not bound to a paid contract version", () => {
    const injected = structuredClone(customerProjectFixture);
    injected.paidCommercialVersion = 1;

    expect(() => parseCustomerProjectSnapshot(injected)).toThrow(
      UnsafeProjectionError,
    );
  });
});

describe("operator projection contracts", () => {
  it("accepts the operator fixture with verifier and provider detail", () => {
    const parsed = OperatorProjectSchema.parse(operatorProjectFixture);
    expect(parsed.candidates).toHaveLength(4);
    expect(parsed.providers).toHaveLength(8);
    expect(parsed.candidates[1]?.status).toBe("passed");
  });

  it("never lets a hard requirement failure become a passed candidate", () => {
    const injected = structuredClone(operatorProjectFixture);
    injected.candidates[1]!.braintrust.hardRequirementsPassed = false;

    expect(() => OperatorProjectSchema.parse(injected)).toThrow();
  });

  it("never accepts active candidates without verified payment", () => {
    const injected = structuredClone(operatorProjectFixture);
    injected.payment = {
      state: "awaiting",
      evidenceSource: null,
      verifiedAt: null,
    };

    expect(() => OperatorProjectSchema.parse(injected)).toThrow();
  });
});
