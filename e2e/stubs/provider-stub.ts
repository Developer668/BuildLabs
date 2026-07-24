import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";

import { stripeSignatureHeader, svixSignatureHeaders } from "../lib/signing.js";
import { answerForTool } from "./model-answers.js";

/** Every external host the BuildLabs services reach out to. */
export const STUBBED_PROVIDER_HOSTS = [
  "api.fireworks.ai",
  "api.stripe.com",
  "api.resend.com",
  "api.elevenlabs.io",
  "api.braintrust.dev",
  "www.braintrust.dev",
  "app.daytona.io",
  "api.machines.dev",
  "api.fly.io",
] as const;

export interface CapturedMail {
  id: string;
  receivedAt: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo: string | null;
  headers: Record<string, string>;
  tags: Array<{ name: string; value: string }>;
  /** Every absolute URL found in the text and HTML bodies, in order. */
  links: string[];
}

export interface CapturedRequest {
  at: string;
  host: string;
  method: string;
  path: string;
  status: number;
}

export interface StubCheckoutSession {
  id: string;
  paymentIntentId: string;
  amountMinor: number;
  currency: string;
  customerEmail: string;
  metadata: Record<string, string>;
  status: "open" | "complete";
  paymentStatus: "unpaid" | "paid";
  url: string;
  created: number;
  expiresAt: number;
}

export interface ProviderStubOptions {
  certificatePem: string;
  keyPem: string;
  stripeWebhookSecret: string;
  resendWebhookSecret: string;
  /** Where signed provider webhooks are delivered (the orchestrator origin). */
  orchestratorOrigin: string;
  elevenLabsAgentId: string;
  /** Domains the Resend stub reports as verified for sending and receiving. */
  resendDomains: readonly string[];
  /** Written to stderr for the harness log; keeps the stub silent otherwise. */
  onLog?: (line: string) => void;
}

export interface ProviderStub {
  tlsPort: number;
  proxyPort: number;
  controlPort: number;
  close(): Promise<void>;
}

interface StubState {
  mail: CapturedMail[];
  requests: CapturedRequest[];
  checkoutSessions: Map<string, StubCheckoutSession>;
  conversations: Map<string, unknown>;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export async function startProviderStub(
  options: ProviderStubOptions,
): Promise<ProviderStub> {
  const state: StubState = {
    mail: [],
    requests: [],
    checkoutSessions: new Map(),
    conversations: new Map(),
  };
  const log = options.onLog ?? (() => undefined);

  const tls = createHttpsServer(
    { cert: options.certificatePem, key: options.keyPem },
    (request, response) => {
      void handleProviderRequest(request, response, state, options, log);
    },
  );
  const tlsPort = await listen(tls);

  // A plain CONNECT tunnel is enough: the client still performs a real TLS
  // handshake, against the stub certificate the services were told to trust.
  const proxy = createHttpServer((_request, response) => {
    response.writeHead(405, JSON_HEADERS);
    response.end(JSON.stringify({ error: "journey_stub_expects_connect" }));
  });
  proxy.on("connect", (request, socket: Socket, head: Buffer) => {
    const upstream = connect(tlsPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    log(`proxy connect ${request.url ?? "?"}`);
  });
  const proxyPort = await listen(proxy);

  const control = createHttpServer((request, response) => {
    void handleControlRequest(request, response, state, options);
  });
  const controlPort = await listen(control);

  return {
    tlsPort,
    proxyPort,
    controlPort,
    async close() {
      await Promise.all([closeServer(tls), closeServer(proxy)]);
      await closeServer(control);
    },
  };
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: StubState,
  options: ProviderStubOptions,
  log: (line: string) => void,
): Promise<void> {
  const host = (request.headers.host ?? "").split(":")[0] ?? "";
  const url = new URL(request.url ?? "/", `https://${host}`);
  const body = await readBody(request);
  let status = 200;
  try {
    switch (host) {
      case "api.fireworks.ai":
        status = fireworks(url, body, response);
        break;
      case "api.stripe.com":
        status = stripe(request.method ?? "GET", url, body, response, state, {
          orchestratorOrigin: options.orchestratorOrigin,
        });
        break;
      case "api.resend.com":
        status = resend(
          request.method ?? "GET",
          url,
          body,
          response,
          state,
          options.resendDomains,
        );
        break;
      case "api.elevenlabs.io":
        status = elevenLabs(url, response, state, options.elevenLabsAgentId);
        break;
      case "api.braintrust.dev":
      case "www.braintrust.dev":
        status = braintrust(url, response);
        break;
      default:
        // Anything else is a provider the journey did not expect to touch.
        // Answering 200 would hide a real cross-service regression.
        status = 502;
        send(response, 502, {
          error: "journey_stub_unstubbed_provider",
          host,
          path: url.pathname,
        });
    }
  } catch (error) {
    status = 500;
    send(response, 500, {
      error: "journey_stub_failed",
      host,
      path: url.pathname,
      message: error instanceof Error ? error.message : String(error),
    });
    log(`stub failure ${host}${url.pathname}: ${String(error)}`);
  }
  state.requests.push({
    at: new Date().toISOString(),
    host,
    method: request.method ?? "GET",
    path: url.pathname,
    status,
  });
}

function fireworks(url: URL, body: string, response: ServerResponse): number {
  if (url.pathname.endsWith("/models")) {
    send(response, 200, { object: "list", data: [] });
    return 200;
  }
  if (!url.pathname.endsWith("/chat/completions")) {
    send(response, 404, { error: { message: "unstubbed fireworks route" } });
    return 404;
  }
  const request = JSON.parse(body) as {
    model?: string;
    messages?: Array<{ role: string; content: unknown }>;
    tools?: Array<{ function?: { name?: string } }>;
  };
  const toolName = request.tools?.[0]?.function?.name;
  const userMessage = request.messages?.findLast(
    (message) => message.role === "user",
  );
  if (!toolName || typeof userMessage?.content !== "string") {
    send(response, 400, {
      error: { message: "journey stub expects one tool and a JSON user turn" },
    });
    return 400;
  }
  const answer = answerForTool({
    toolName,
    input: JSON.parse(userMessage.content) as Record<string, unknown>,
  });
  send(response, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: request.model ?? "journey-stub",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${randomUUID().replaceAll("-", "")}`,
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(answer) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  return 200;
}

function stripe(
  method: string,
  url: URL,
  body: string,
  response: ServerResponse,
  state: StubState,
  context: { orchestratorOrigin: string },
): number {
  if (method === "GET" && url.pathname === "/v1/checkout/sessions") {
    send(response, 200, {
      object: "list",
      has_more: false,
      url: "/v1/checkout/sessions",
      data: [],
    });
    return 200;
  }
  if (method === "GET" && url.pathname === "/v1/webhook_endpoints") {
    send(response, 200, {
      object: "list",
      has_more: false,
      url: "/v1/webhook_endpoints",
      data: [
        {
          id: "we_journey_stub",
          object: "webhook_endpoint",
          application: null,
          livemode: false,
          status: "enabled",
          url: `${context.orchestratorOrigin}/v1/orchestration/webhooks/stripe`,
          enabled_events: [
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
          ],
        },
      ],
    });
    return 200;
  }
  if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
    const form = new URLSearchParams(body);
    const session = createCheckoutSession(form);
    state.checkoutSessions.set(session.id, session);
    send(response, 200, checkoutSessionJson(session));
    return 200;
  }
  const sessionMatch = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && sessionMatch?.[1]) {
    const session = state.checkoutSessions.get(sessionMatch[1]);
    if (!session) {
      send(response, 404, { error: { message: "No such checkout.session" } });
      return 404;
    }
    send(response, 200, checkoutSessionJson(session));
    return 200;
  }
  const intentMatch = /^\/v1\/payment_intents\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && intentMatch?.[1]) {
    const session = [...state.checkoutSessions.values()].find(
      (candidate) => candidate.paymentIntentId === intentMatch[1],
    );
    if (!session || session.paymentStatus !== "paid") {
      send(response, 404, { error: { message: "No such payment_intent" } });
      return 404;
    }
    send(response, 200, paymentIntentJson(session));
    return 200;
  }
  send(response, 404, {
    error: { message: `unstubbed stripe route ${method} ${url.pathname}` },
  });
  return 404;
}

function createCheckoutSession(form: URLSearchParams): StubCheckoutSession {
  const id = `cs_test_${randomUUID().replaceAll("-", "")}`;
  const metadata: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    const match = /^metadata\[(.+)\]$/.exec(key);
    if (match?.[1]) {
      metadata[match[1]] = value;
    }
  }
  const created = Math.floor(Date.now() / 1_000);
  return {
    id,
    paymentIntentId: `pi_test_${randomUUID().replaceAll("-", "")}`,
    amountMinor: Number(
      form.get("line_items[0][price_data][unit_amount]") ?? "0",
    ),
    currency: form.get("line_items[0][price_data][currency]") ?? "usd",
    customerEmail: form.get("customer_email") ?? "",
    metadata,
    status: "open",
    paymentStatus: "unpaid",
    url: `https://checkout.stripe.com/c/pay/${id}`,
    created,
    expiresAt: created + 24 * 60 * 60,
  };
}

function checkoutSessionJson(
  session: StubCheckoutSession,
): Record<string, unknown> {
  return {
    id: session.id,
    object: "checkout.session",
    amount_total: session.amountMinor,
    amount_subtotal: session.amountMinor,
    client_reference_id: session.metadata.buildlabs_project_id ?? null,
    created: session.created,
    currency: session.currency,
    customer: null,
    customer_details: { email: session.customerEmail },
    customer_email: session.customerEmail,
    expires_at: session.expiresAt,
    livemode: false,
    metadata: session.metadata,
    mode: "payment",
    payment_intent:
      session.paymentStatus === "paid" ? session.paymentIntentId : null,
    payment_status: session.paymentStatus,
    status: session.status,
    url: session.status === "open" ? session.url : null,
  };
}

function paymentIntentJson(
  session: StubCheckoutSession,
): Record<string, unknown> {
  return {
    id: session.paymentIntentId,
    object: "payment_intent",
    amount: session.amountMinor,
    amount_received: session.amountMinor,
    created: session.created,
    currency: session.currency,
    customer: null,
    livemode: false,
    metadata: session.metadata,
    receipt_email: session.customerEmail,
    status: "succeeded",
  };
}

function resend(
  method: string,
  url: URL,
  body: string,
  response: ServerResponse,
  state: StubState,
  domains: readonly string[],
): number {
  if (method === "GET" && url.pathname === "/domains") {
    send(response, 200, {
      object: "list",
      data: domains.map((domain) => domainRecord(domain)),
    });
    return 200;
  }
  if (method === "GET" && url.pathname === "/webhooks") {
    send(response, 200, { object: "list", data: [] });
    return 200;
  }
  if (method === "POST" && url.pathname === "/emails") {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const mail = captureMail(payload);
    state.mail.push(mail);
    send(response, 200, { id: mail.id });
    return 200;
  }
  const emailMatch = /^\/emails\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && emailMatch?.[1]) {
    const mail = state.mail.find((candidate) => candidate.id === emailMatch[1]);
    if (!mail) {
      send(response, 404, { message: "Email not found", name: "not_found" });
      return 404;
    }
    send(response, 200, {
      object: "email",
      id: mail.id,
      to: mail.to,
      from: mail.from,
      subject: mail.subject,
      created_at: mail.receivedAt,
      last_event: "delivered",
    });
    return 200;
  }
  send(response, 404, {
    message: `unstubbed resend route ${method} ${url.pathname}`,
    name: "not_found",
  });
  return 404;
}

function domainRecord(name: string): Record<string, unknown> {
  return {
    id: `dom_${name}`,
    name,
    status: "verified",
    region: "us-east-1",
    capabilities: { sending: "enabled", receiving: "enabled" },
  };
}

function captureMail(payload: Record<string, unknown>): CapturedMail {
  const text = typeof payload.text === "string" ? payload.text : "";
  const html = typeof payload.html === "string" ? payload.html : "";
  const to = Array.isArray(payload.to)
    ? payload.to.filter((value): value is string => typeof value === "string")
    : typeof payload.to === "string"
      ? [payload.to]
      : [];
  return {
    id: `email_${randomUUID()}`,
    receivedAt: new Date().toISOString(),
    from: typeof payload.from === "string" ? payload.from : "",
    to,
    subject: typeof payload.subject === "string" ? payload.subject : "",
    text,
    html,
    replyTo:
      typeof payload.reply_to === "string"
        ? payload.reply_to
        : typeof payload.replyTo === "string"
          ? payload.replyTo
          : null,
    headers: isRecord(payload.headers)
      ? Object.fromEntries(
          Object.entries(payload.headers).map(([key, value]) => [
            key,
            String(value),
          ]),
        )
      : {},
    tags: Array.isArray(payload.tags)
      ? payload.tags.filter(isTag).map((tag) => ({
          name: tag.name,
          value: tag.value,
        }))
      : [],
    links: extractLinks(`${text}\n${html}`),
  };
}

function isTag(value: unknown): value is { name: string; value: string } {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.value === "string"
  );
}

function extractLinks(body: string): string[] {
  const found = body.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
  return [...new Set(found.map((link) => link.replace(/[.,;]+$/, "")))];
}

function elevenLabs(
  url: URL,
  response: ServerResponse,
  state: StubState,
  agentId: string,
): number {
  if (url.pathname === "/v1/convai/conversation/get-signed-url") {
    const conversationId = `conv_${randomUUID().replaceAll("-", "")}`;
    state.conversations.set(conversationId, null);
    const signed = new URL("wss://api.elevenlabs.io/v1/convai/conversation");
    signed.searchParams.set(
      "agent_id",
      url.searchParams.get("agent_id") ?? agentId,
    );
    signed.searchParams.set("conversation_id", conversationId);
    signed.searchParams.set("token", randomUUID().replaceAll("-", ""));
    send(response, 200, {
      signed_url: signed.toString(),
      conversation_id: conversationId,
    });
    return 200;
  }
  const conversationMatch = /^\/v1\/convai\/conversations\/([^/]+)$/.exec(
    url.pathname,
  );
  if (conversationMatch?.[1]) {
    const stored = state.conversations.get(conversationMatch[1]);
    if (stored === undefined || stored === null) {
      send(response, 404, { detail: "conversation not staged" });
      return 404;
    }
    send(response, 200, stored);
    return 200;
  }
  send(response, 404, { detail: `unstubbed elevenlabs ${url.pathname}` });
  return 404;
}

function braintrust(url: URL, response: ServerResponse): number {
  if (url.pathname === "/v1/project") {
    send(response, 200, {
      objects: [{ id: randomUUID(), name: "BuildLabs", org_id: randomUUID() }],
    });
    return 200;
  }
  send(response, 200, { ok: true, row_ids: [] });
  return 200;
}

async function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: StubState,
  options: ProviderStubOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  if (method === "GET" && url.pathname === "/__e2e/health") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (method === "GET" && url.pathname === "/__e2e/mail") {
    send(response, 200, { items: state.mail });
    return;
  }
  if (method === "GET" && url.pathname === "/__e2e/requests") {
    send(response, 200, { items: state.requests });
    return;
  }
  if (method === "GET" && url.pathname === "/__e2e/checkout-sessions") {
    send(response, 200, { items: [...state.checkoutSessions.values()] });
    return;
  }
  if (method === "POST" && url.pathname === "/__e2e/elevenlabs/conversation") {
    const payload = JSON.parse(await readBody(request)) as {
      conversationId?: string;
      body?: unknown;
    };
    if (!payload.conversationId) {
      send(response, 400, { error: "conversationId is required" });
      return;
    }
    state.conversations.set(payload.conversationId, payload.body ?? {});
    send(response, 200, { staged: true });
    return;
  }
  const payMatch = /^\/__e2e\/checkout-sessions\/([^/]+)\/pay$/.exec(
    url.pathname,
  );
  if (method === "POST" && payMatch?.[1]) {
    const session = state.checkoutSessions.get(payMatch[1]);
    if (!session) {
      send(response, 404, { error: "unknown checkout session" });
      return;
    }
    session.status = "complete";
    session.paymentStatus = "paid";
    const delivered = await deliverStripePaidWebhook(session, options);
    send(response, 200, delivered);
    return;
  }
  if (method === "POST" && url.pathname === "/__e2e/resend/delivered") {
    const payload = JSON.parse(await readBody(request)) as { emailId?: string };
    const mail = state.mail.find((item) => item.id === payload.emailId);
    if (!mail) {
      send(response, 404, { error: "unknown email" });
      return;
    }
    const delivered = await deliverResendWebhook(mail, options);
    send(response, 200, delivered);
    return;
  }
  send(response, 404, { error: "unknown control route", path: url.pathname });
}

async function deliverStripePaidWebhook(
  session: StubCheckoutSession,
  options: ProviderStubOptions,
): Promise<Record<string, unknown>> {
  const event = {
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    api_version: "2025-10-29.clover",
    created: Math.floor(Date.now() / 1_000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: "checkout.session.completed",
    data: { object: checkoutSessionJson(session) },
  };
  const payload = JSON.stringify(event);
  const response = await fetch(
    `${options.orchestratorOrigin}/v1/orchestration/webhooks/stripe`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignatureHeader(
          payload,
          options.stripeWebhookSecret,
        ),
      },
      body: payload,
    },
  );
  return {
    eventId: event.id,
    status: response.status,
    body: await response.text(),
  };
}

async function deliverResendWebhook(
  mail: CapturedMail,
  options: ProviderStubOptions,
): Promise<Record<string, unknown>> {
  const event = {
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: {
      email_id: mail.id,
      created_at: mail.receivedAt,
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      tags: mail.tags,
    },
  };
  const payload = JSON.stringify(event);
  const signature = svixSignatureHeaders(payload, options.resendWebhookSecret);
  const response = await fetch(
    `${options.orchestratorOrigin}/v1/orchestration/webhooks/resend`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": signature.id,
        "svix-timestamp": signature.timestamp,
        "svix-signature": signature.signature,
      },
      body: payload,
    },
  );
  return {
    emailId: mail.id,
    status: response.status,
    body: await response.text(),
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...JSON_HEADERS,
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Journey stub failed to bind a loopback port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
