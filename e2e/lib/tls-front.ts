import { createServer, type Server } from "node:https";
import { request as httpRequest } from "node:http";

export interface TlsFront {
  port: number;
  close(): Promise<void>;
}

/**
 * The emailed customer login link must be an HTTPS URL on the dashboard's own
 * origin — the orchestrator's config schema rejects anything else, and that
 * rejection is part of what the dead-end-link fix relies on. So the journey
 * fronts the loopback dashboard with TLS and teaches Chromium to resolve the
 * public hostname here. The link the browser opens is then byte-identical to
 * the one the customer would receive.
 */
export async function startDashboardTlsFront(options: {
  certificatePem: string;
  keyPem: string;
  targetHost: string;
  targetPort: number;
}): Promise<TlsFront> {
  const server = createServer(
    { cert: options.certificatePem, key: options.keyPem },
    (incoming, response) => {
      const proxied = httpRequest(
        {
          host: options.targetHost,
          port: options.targetPort,
          method: incoming.method ?? "GET",
          path: incoming.url ?? "/",
          headers: {
            ...incoming.headers,
            // Next.js binds to loopback and rejects unknown hosts on some
            // routes; forward the real client host separately instead.
            host: `${options.targetHost}:${String(options.targetPort)}`,
            "x-forwarded-host": incoming.headers.host ?? "",
            "x-forwarded-proto": "https",
          },
        },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      proxied.on("error", () => {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end("dashboard tls front: upstream unavailable");
      });
      incoming.pipe(proxied);
    },
  );
  const port = await listen(server);
  return {
    port,
    close: () => closeServer(server),
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Dashboard TLS front failed to bind"));
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
