import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const CUSTOMER_FIXTURE = "/dashboard/fixtures/customer";
const FIXTURE_BUILDER = "bld_aaaaaaaaaaaaaaaaaaaaaa";
const OPERATOR_TOKEN = "fixture-operator-token";

test.describe("dashboard fixture surfaces", () => {
  test("customer cockpit is stable, bounded, and accessible", async ({
    page,
    request,
  }, testInfo) => {
    const errors = captureBrowserDiagnostics(page);
    await page.goto(CUSTOMER_FIXTURE);
    await expect(
      page.getByRole("heading", { name: "Build cockpit" }),
    ).toBeVisible();

    await expect(
      page.getByText("Deterministic fixture", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("FIXTURE", { exact: true })).toBeVisible();
    await expect(page.getByText("UNVERIFIED WIP")).toHaveCount(4);
    await expect(page.locator(".candidate-lane")).toHaveCount(4);
    const summaryVersions = page.locator(
      ".customer-summary .summary-cell .metric-value",
    );
    await expect(summaryVersions).toHaveText(["v3", "v3", "v2"]);
    await expect(
      page.getByText("Prior proven release remains current"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Frozen proven preview" }),
    ).toHaveAttribute("href", "https://preview.example.invalid/northstar-v2");

    const cockpit = page
      .getByRole("heading", { name: "Build cockpit" })
      .locator("xpath=ancestor::section[1]");
    await expect(
      cockpit.getByRole("button", { name: /approve|download|deploy|source/i }),
    ).toHaveCount(0);
    await expect(
      cockpit.getByRole("link", { name: /approve|download|deploy|source/i }),
    ).toHaveCount(0);

    const secondLane = cockpit.getByRole("button", { name: /Builder 2/i });
    await secondLane.focus();
    await page.keyboard.press("Enter");
    await expect(secondLane).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Builder 2 selected")).toBeVisible();

    const raster = await request.get(`/api/fixtures/wip/${FIXTURE_BUILDER}`);
    expect(raster.status()).toBe(200);
    expect(raster.headers()["content-type"]).toBe("image/png");
    expect(raster.headers()["x-content-type-options"]).toBe("nosniff");
    expect(raster.headers()["cache-control"]).toContain("no-store");
    expect(Array.from((await raster.body()).subarray(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);

    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxeViolations(page);
    expect(errors, `${testInfo.project.name} customer console errors`).toEqual(
      [],
    );
  });

  test("operator sign-in opens the evidence cockpit", async ({
    page,
  }, testInfo) => {
    const errors = captureBrowserDiagnostics(page);
    await page.goto("/operator");
    await expect(page).toHaveURL(/\/operator\/sign-in$/);
    await page.getByLabel("Operator access token").fill(OPERATOR_TOKEN);
    await page.getByRole("button", { name: "Open studio" }).click();
    await expect(page).toHaveURL(/\/operator$/);

    await expect(
      page.getByRole("heading", { name: "Candidate cockpit" }),
    ).toBeVisible();
    await expect(
      page.getByText("Deterministic fixture", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("UNVERIFIED WIP")).toHaveCount(4);
    await expect(page.locator(".candidate-lane")).toHaveCount(4);
    await expect(
      page.getByText(
        "Revision 3 is unverified work. Release 2 remains the only production-bound artifact.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Refresh reads the authenticated projection only. No mutation route is wired here, and there is no manual ship, proof override, or failed-requirement bypass.",
      ),
    ).toBeVisible();

    const fourthCandidate = page.getByRole("button", {
      name: /Candidate 04.*failed/i,
    });
    await fourthCandidate.focus();
    await page.keyboard.press("Enter");
    await expect(fourthCandidate).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("heading", { name: "Evidence · Candidate 04" }),
    ).toBeVisible();
    await expect(page.getByText("360px administrative queue")).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAxeViolations(page);
    expect(errors, `${testInfo.project.name} operator console errors`).toEqual(
      [],
    );
  });
});

function captureBrowserDiagnostics(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    errors.push(
      `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  page.on("request", (request) => {
    if (!isLoopbackBrowserUrl(request.url())) {
      errors.push(`external request: ${request.method()} ${request.url()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      errors.push(
        `response: ${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });
  page.on("websocket", (socket) => {
    if (!isLoopbackBrowserUrl(socket.url())) {
      errors.push(`external websocket: ${socket.url()}`);
    }
  });
  return errors;
}

function isLoopbackBrowserUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "data:" ||
    url.protocol === "blob:" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  );
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const offenders = Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.right <= root.clientWidth + 1 && rect.left >= -1) {
          return false;
        }
        let parent = element.parentElement;
        while (parent && parent !== document.body) {
          const overflowX = getComputedStyle(parent).overflowX;
          if (
            overflowX === "auto" ||
            overflowX === "scroll" ||
            overflowX === "hidden" ||
            overflowX === "clip"
          ) {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      })
      .slice(0, 10)
      .map((element) => ({
        className: element.className,
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 80),
      }));
    return {
      clientWidth: root.clientWidth,
      offenders,
      scrollWidth: root.scrollWidth,
    };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.offenders).toEqual([]);
}

async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}
