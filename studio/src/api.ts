import type {
  EventsResponse,
  EvidenceResponse,
  PreviewResponse,
  StudioConnection,
  StudioRunsResponse,
  StudioSelection,
  StudioRun,
} from "./types";

const CONNECTION_KEY = "buildlabs.studio.connection.v1";

export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

export function loadConnection(): StudioConnection {
  try {
    const stored = sessionStorage.getItem(CONNECTION_KEY);
    if (!stored) {
      return { baseUrl: "", token: "" };
    }
    const parsed = JSON.parse(stored) as Partial<StudioConnection>;
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      token: typeof parsed.token === "string" ? parsed.token : "",
    };
  } catch {
    return { baseUrl: "", token: "" };
  }
}

export function saveConnection(connection: StudioConnection): void {
  sessionStorage.setItem(CONNECTION_KEY, JSON.stringify(connection));
}

export async function loadStudioRuns(
  connection: StudioConnection,
  signal?: AbortSignal,
): Promise<StudioRunsResponse> {
  return request<StudioRunsResponse>(
    connection,
    "/v1/studio/runs?limit=24",
    signal,
  );
}

export async function loadStudioSelection(
  connection: StudioConnection,
  run: StudioRun,
  signal?: AbortSignal,
): Promise<StudioSelection> {
  const encodedRunId = encodeURIComponent(run.run.id);
  const [events, evidence, preview] = await Promise.all([
    request<EventsResponse>(
      connection,
      `/v1/build-runs/${encodedRunId}/events?after=0&limit=500`,
      signal,
    ),
    request<EvidenceResponse>(
      connection,
      `/v1/build-runs/${encodedRunId}/evidence`,
      signal,
    ),
    run.previewAvailable
      ? request<PreviewResponse>(
          connection,
          `/v1/build-runs/${encodedRunId}/preview`,
          signal,
        ).catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    run,
    events: events.events,
    evidence: evidence.evidence,
    preview,
  };
}

export async function submitStudioDemoIntake(
  connection: StudioConnection,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const baseUrl = connection.baseUrl.trim().replace(/\/$/, "");
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    "Idempotency-Key": `studio-demo:${crypto.randomUUID()}`,
  });
  if (connection.token.trim()) {
    headers.set("Authorization", `Bearer ${connection.token.trim()}`);
  }
  const response = await fetch(`${baseUrl}/v1/demo-intakes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, researchConsent: false }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    let message = `Text demo failed with ${response.status}`;
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === "string") message = payload.message;
    } catch {
      // Preserve the bounded status message.
    }
    throw new StudioApiError(response.status, message);
  }
}

async function request<T>(
  connection: StudioConnection,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const baseUrl = connection.baseUrl.trim().replace(/\/$/, "");
  const headers = new Headers({ Accept: "application/json" });
  if (connection.token.trim()) {
    headers.set("Authorization", `Bearer ${connection.token.trim()}`);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    let message = `Studio request failed with ${response.status}`;
    try {
      const payload = (await response.json()) as {
        message?: unknown;
        error?: unknown;
      };
      if (typeof payload.message === "string") {
        message = payload.message;
      } else if (typeof payload.error === "string") {
        message = payload.error;
      }
    } catch {
      // The response was not JSON; the status remains the useful diagnostic.
    }
    throw new StudioApiError(response.status, message);
  }
  return (await response.json()) as T;
}
