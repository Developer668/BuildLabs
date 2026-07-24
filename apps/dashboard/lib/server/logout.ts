import { dashboardAliasSecret, sessionBinding } from "./aliases";
import {
  clearDashboardCookies,
  customerSessionToken,
  requireCustomerCsrf,
} from "./cookies";
import { bffErrorResponse, customerJson } from "./http";
import { customerProjectionRegistry } from "./projection-registry";

export function handleCustomerLogout(request: Request): Response {
  if (request.method !== "POST") {
    return customerJson(
      { error: "method_not_allowed", message: "POST is required" },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  try {
    requireCustomerCsrf(request);
    const binding = sessionBinding(
      customerSessionToken(request),
      dashboardAliasSecret(),
    );
    customerProjectionRegistry.clearSession(binding);
    const headers = new Headers();
    for (const cookie of clearDashboardCookies()) {
      headers.append("set-cookie", cookie);
    }
    return customerJson(
      {
        status: "local_session_cleared",
        globalRevocation: false,
      },
      { status: 200, headers },
    );
  } catch (error) {
    return bffErrorResponse(error);
  }
}
