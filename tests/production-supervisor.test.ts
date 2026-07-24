import { describe, expect, it } from "vitest";

import { determineSupervisorExitCode } from "../src/production-supervisor-policy.js";

describe("production supervisor exit policy", () => {
  it("fails when a required child exits unexpectedly even with code zero", () => {
    expect(
      determineSupervisorExitCode({
        unexpectedExit: true,
        forcedShutdown: false,
        requestedSignal: "SIGTERM",
        childResults: [
          { code: 0, signal: null },
          { code: 0, signal: null },
        ],
      }),
    ).toBe(1);
  });

  it("fails when a child reports failure or requires SIGKILL", () => {
    expect(
      determineSupervisorExitCode({
        unexpectedExit: false,
        forcedShutdown: false,
        requestedSignal: "SIGTERM",
        childResults: [
          { code: 1, signal: null },
          { code: null, signal: "SIGTERM" },
        ],
      }),
    ).toBe(1);
    expect(
      determineSupervisorExitCode({
        unexpectedExit: false,
        forcedShutdown: true,
        requestedSignal: "SIGTERM",
        childResults: [
          { code: 0, signal: null },
          { code: null, signal: "SIGKILL" },
        ],
      }),
    ).toBe(1);
  });

  it("preserves conventional exit codes for graceful operator signals", () => {
    const childResults = [
      { code: 0, signal: null },
      { code: 0, signal: null },
    ] as const;
    expect(
      determineSupervisorExitCode({
        unexpectedExit: false,
        forcedShutdown: false,
        requestedSignal: "SIGINT",
        childResults,
      }),
    ).toBe(130);
    expect(
      determineSupervisorExitCode({
        unexpectedExit: false,
        forcedShutdown: false,
        requestedSignal: "SIGTERM",
        childResults,
      }),
    ).toBe(143);
  });
});
