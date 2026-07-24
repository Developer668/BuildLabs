export function dashboardFixturesEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.BUILDLABS_DASHBOARD_FIXTURES === "1"
  );
}
