import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomerWorkspace } from "../components/customer-workspace";
import {
  CUSTOMER_FIXTURE_PROJECT_ID,
  customerEventFixtures,
  customerFixtureSnapshot,
  customerProjectFixture,
} from "../lib/fixtures";

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotKit: ({ children }: { children: ReactNode }) => children,
  useAgent: () => ({ isReady: false }),
  useAgentContext: vi.fn(),
  useHumanInTheLoop: vi.fn(),
  useRenderTool: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie =
    "buildlabs_dashboard_csrf=; Path=/; Max-Age=0; SameSite=Strict";
});

function renderFixture(snapshot = customerProjectFixture) {
  return render(
    <CustomerWorkspace
      fixture
      initialEvents={customerEventFixtures}
      initialSnapshot={snapshot}
      projectAlias={CUSTOMER_FIXTURE_PROJECT_ID}
    />,
  );
}

describe("customer workspace UI truth boundaries", () => {
  it("keeps four stable WIP lanes distinct from proven release controls", () => {
    renderFixture();

    const buildSection = screen
      .getByRole("heading", { name: "Build cockpit" })
      .closest<HTMLElement>("section");
    expect(buildSection).not.toBeNull();
    const build = within(buildSection!);

    expect(build.getAllByRole("article")).toHaveLength(4);
    expect(build.getAllByText("UNVERIFIED WIP")).toHaveLength(4);
    expect(build.getByText("Awaiting a sanitized frame")).toBeInTheDocument();
    expect(build.getByText("WIP render unavailable")).toBeInTheDocument();
    expect(
      build.getByText("Observation blocked by safety checks"),
    ).toBeInTheDocument();

    for (const prohibited of [/approve/i, /download/i, /deploy/i, /source/i]) {
      expect(build.queryByRole("button", { name: prohibited })).toBeNull();
      expect(build.queryByRole("link", { name: prohibited })).toBeNull();
    }

    const proofSection = screen
      .getByRole("heading", { name: "Proof and releases" })
      .closest<HTMLElement>("section");
    expect(proofSection).not.toBeNull();
    expect(
      within(proofSection!).getByRole("link", {
        name: "Frozen proven preview",
      }),
    ).toHaveAttribute("href", customerProjectFixture.preview!.url);
  });

  it("labels the exact active-versus-proven version mismatch", () => {
    renderFixture();

    const summary = screen
      .getByText("APPROVED SCOPE")
      .closest<HTMLElement>(".summary-strip");
    expect(summary).not.toBeNull();
    expect(within(summary!).getAllByText("v3")).toHaveLength(2);
    expect(
      within(summary!).getByText("Prior proven release remains current"),
    ).toBeInTheDocument();

    expect(
      screen.getByAltText(/contract version 3/i).getAttribute("src"),
    ).toMatch(/\/api\/fixtures\/wip\/bld_aaaaaaaaaaaaaaaaaaaaaa$/);
    expect(
      screen.getByText(
        "Receipts are still being recorded. No candidate is implied proven.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("v2").length).toBeGreaterThanOrEqual(2);
  });

  it("preserves bounded long project and requirement text in the DOM", () => {
    const longTitle =
      `Project ${"Northstar appointment operations ".repeat(12)}`.trim();
    const longRequirement =
      `A keyboard user must retain a visible, deterministic focus target after every scheduling transition. ${"The requirement remains version-bound and evidence-backed. ".repeat(24)}`.trim();
    const contract = customerProjectFixture.contract!;
    const snapshot = customerFixtureSnapshot({
      title: longTitle,
      contract: {
        ...contract,
        title: longTitle,
        requirements: [
          { ...contract.requirements[0]!, text: longRequirement },
          ...contract.requirements.slice(1),
        ],
      },
    });

    const view = renderFixture(snapshot);

    expect(
      screen.getByRole("heading", { level: 1, name: longTitle }),
    ).toHaveTextContent(longTitle);
    expect(screen.getByText(longRequirement)).toHaveTextContent(
      longRequirement,
    );
    expect(
      view.container.querySelector(".candidate-grid")?.children,
    ).toHaveLength(4);
    expect(
      view.container.querySelector(".project-chip strong"),
    ).toHaveAttribute("title", longTitle);
  });

  it("shows explicit empty proof, preview, and production states", () => {
    const snapshot = customerFixtureSnapshot({
      currentProvenVersion: null,
      currentProductionVersion: null,
      proof: null,
      preview: null,
      production: null,
      milestoneStates: customerProjectFixture.milestoneStates.map(
        (milestone) =>
          milestone.id === "proof" ||
          milestone.id === "preview" ||
          milestone.id === "production"
            ? {
                ...milestone,
                state: "not_started" as const,
                receiptAt: null,
              }
            : milestone,
      ),
    });

    renderFixture(snapshot);

    expect(screen.getByText("Awaiting proof")).toBeInTheDocument();
    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
    expect(screen.getByText("Production unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "A health-verified production receipt is not available.",
      ),
    ).toBeInTheDocument();
  });

  it("reports steering as received only after the authenticated route responds", async () => {
    document.cookie =
      "buildlabs_dashboard_csrf=fixture-csrf; Path=/; SameSite=Strict";
    const fetchMock = vi.fn(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = String(request);
        if (url.endsWith("/steering") && init?.method === "POST") {
          return Response.json(
            { status: "received" },
            { status: 202, headers: { "Cache-Control": "no-store" } },
          );
        }
        return Response.json(customerProjectFixture, {
          status: 200,
          headers: { "Cache-Control": "no-store" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderFixture();
    fireEvent.change(screen.getByPlaceholderText("Short request title"), {
      target: { value: "Clarify the scheduling queue" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Describe the change or clarification."),
      {
        target: {
          value:
            "Please keep the current version and clarify the expected queue ordering.",
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "Request received. Scope, pricing, and contract impact are still being classified.",
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/received does not mean accepted or in scope/i),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText(
        /request accepted|change implemented|shipping approved/i,
      ),
    ).toBeNull();
  });

  it("labels every fixture surface as non-provider state", () => {
    renderFixture();

    expect(screen.getByText("Deterministic fixture")).toBeInTheDocument();
    expect(screen.getByText("FIXTURE")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This is a deterministic fixture snapshot for local QA. It is not a provider run and does not represent current browser liveness.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Fixture snapshot")).toBeInTheDocument();
  });
});
