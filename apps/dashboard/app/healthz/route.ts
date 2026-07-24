export function GET(): Response {
  return Response.json({
    status: "ok",
    component: "buildlabs-dashboard",
    fixtureMode:
      process.env.NODE_ENV !== "production" &&
      process.env.BUILDLABS_DASHBOARD_FIXTURES === "1",
  });
}
