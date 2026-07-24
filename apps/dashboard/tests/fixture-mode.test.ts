import { afterEach, describe, expect, it } from "vitest";

import { dashboardFixturesEnabled } from "../lib/fixture-mode";

const originalNodeEnv = process.env.NODE_ENV;
const originalFixtureFlag = process.env.BUILDLABS_DASHBOARD_FIXTURES;

afterEach(() => {
  restoreEnv("NODE_ENV", originalNodeEnv);
  restoreEnv("BUILDLABS_DASHBOARD_FIXTURES", originalFixtureFlag);
});

describe("dashboard fixture mode", () => {
  it("allows fixtures only outside production with the explicit local flag", () => {
    setEnv("NODE_ENV", "test");
    setEnv("BUILDLABS_DASHBOARD_FIXTURES", "1");
    expect(dashboardFixturesEnabled()).toBe(true);
  });

  it("rejects fixtures in production even when the flag is set", () => {
    setEnv("NODE_ENV", "production");
    setEnv("BUILDLABS_DASHBOARD_FIXTURES", "1");
    expect(dashboardFixturesEnabled()).toBe(false);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  setEnv(name, value);
}

function setEnv(name: string, value: string): void {
  Reflect.set(process.env, name, value);
}
