import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperatorStudio } from "../components/operator-studio";
import { operatorFixture } from "../lib/operator-data";

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotKit: ({ children }: { children: ReactNode }) => children,
  useAgent: () => ({ isReady: false }),
  useAgentContext: vi.fn(),
  useHumanInTheLoop: vi.fn(),
  useRenderTool: vi.fn(),
}));

afterEach(cleanup);

describe("operator studio UI", () => {
  it("renders four stable candidate lanes with truthful observation states", () => {
    render(<OperatorStudio project={operatorFixture} />);

    const cockpit = screen
      .getByRole("heading", { name: "Candidate cockpit" })
      .closest("section");
    expect(cockpit).not.toBeNull();
    const lanes = within(cockpit!).getAllByRole("article");

    expect(lanes).toHaveLength(4);
    expect(within(cockpit!).getAllByText("UNVERIFIED WIP")).toHaveLength(4);
    expect(
      within(cockpit!).getAllByText("FIXTURE RASTER PROJECTION"),
    ).toHaveLength(2);
    expect(
      within(cockpit!).getByText("Awaiting a sanitized frame"),
    ).toBeInTheDocument();
    expect(
      within(cockpit!).getByText("Observation unavailable"),
    ).toBeInTheDocument();
    expect(
      within(cockpit!).getAllByText(
        "No browser liveness or visual progress is inferred from this state.",
      ),
    ).toHaveLength(2);
  });

  it("switches selected evidence without implying a hard-failure override", () => {
    render(<OperatorStudio project={operatorFixture} />);

    const failedCandidate = screen.getByRole("button", {
      name: /Candidate 04.*failed/i,
    });
    fireEvent.click(failedCandidate);

    expect(failedCandidate).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("heading", { name: "Evidence · Candidate 04" }),
    ).toBeInTheDocument();
    expect(screen.getByText("360px administrative queue")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Hard requirements 3/4. A quality score cannot override a hard failure.",
      ),
    ).toBeInTheDocument();
  });

  it("exposes bounded operator commands and no shipping approval", () => {
    render(<OperatorStudio project={operatorFixture} />);

    expect(
      screen.getByRole("button", { name: "Refresh durable snapshot" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clarification unavailable" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Verifier retry unavailable" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Refresh reads the authenticated projection only. No mutation route is wired here, and there is no manual ship, proof override, or failed-requirement bypass.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /ship|approve|override|bypass/i }),
    ).toBeNull();
  });

  it("labels fixture, provider, payment, and prior-release truth explicitly", () => {
    render(<OperatorStudio project={operatorFixture} />);

    expect(screen.getByText("Deterministic fixture")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Revision 3 is unverified work. Release 2 remains the only production-bound artifact.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Provider observations")).toBeInTheDocument();
    expect(screen.getAllByText(/signed webhook/).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(screen.getByText("Frozen review preview")).toBeInTheDocument();
    expect(screen.getByText("Production deployment")).toBeInTheDocument();
    expect(screen.getByText("Delivery effect")).toBeInTheDocument();
  });
});
