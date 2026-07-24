import { dashboardFixturesEnabled } from "../../lib/fixture-mode";

export function GET(): Response {
  return Response.json({
    status: "ok",
    component: "buildlabs-dashboard",
    fixtureMode: dashboardFixturesEnabled(),
  });
}
