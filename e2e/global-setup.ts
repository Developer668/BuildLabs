import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureStubCertificate } from "./lib/certs.js";
import {
  JOURNEY_ELEVENLABS,
  JOURNEY_HOSTS,
  JOURNEY_SECRETS,
  buildBackendEnvironment,
  dashboardEnvironment,
  orchestratorEnvironment,
  voiceIntakeEnvironment,
  type ServiceEndpoints,
  type StubWiring,
} from "./lib/environment.js";
import {
  startService,
  stopServices,
  type ServiceHandle,
} from "./lib/processes.js";
import { writeJourneyRuntime, type JourneyRuntime } from "./lib/runtime.js";
import { startDashboardTlsFront } from "./lib/tls-front.js";
import { writeFakeMicrophoneWav } from "./lib/wav.js";
import {
  STUBBED_PROVIDER_HOSTS,
  startProviderStub,
  type ProviderStub,
} from "./stubs/provider-stub.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface TeardownState {
  services: ServiceHandle[];
  stub: ProviderStub | undefined;
  tlsFront: { close(): Promise<void> } | undefined;
}

const teardown: TeardownState = {
  services: [],
  stub: undefined,
  tlsFront: undefined,
};

export default async function globalSetup(): Promise<() => Promise<void>> {
  const live = process.env.E2E_LIVE === "1";
  const runDirectory = join(repositoryRoot, ".buildlabs", "e2e-journey");
  rmSync(runDirectory, { force: true, recursive: true });
  mkdirSync(join(runDirectory, "logs"), { recursive: true });
  mkdirSync(join(runDirectory, "coderabbit-home"), { recursive: true });

  const degradations: string[] = [];
  const endpoints: ServiceEndpoints = {
    buildBackendPort: await freePort(3_410),
    orchestratorPort: await freePort(3_411),
    dashboardPort: await freePort(3_412),
    voicePort: await freePort(3_413),
  };

  const audioFixturePath = writeFakeMicrophoneWav(
    join(runDirectory, "fake-microphone.wav"),
  );

  const certificate = ensureStubCertificate(runDirectory, [
    ...STUBBED_PROVIDER_HOSTS,
    JOURNEY_HOSTS.dashboard,
    JOURNEY_HOSTS.orchestrator,
  ]);

  let stubWiring: StubWiring | undefined;
  let stubControlOrigin = "";
  if (!live) {
    const stub = await startProviderStub({
      certificatePem: certificate.certificatePem,
      keyPem: certificate.keyPem,
      stripeWebhookSecret: JOURNEY_SECRETS.stripeWebhookSecret,
      resendWebhookSecret: JOURNEY_SECRETS.resendWebhookSecret,
      orchestratorOrigin: `http://127.0.0.1:${String(endpoints.orchestratorPort)}`,
      elevenLabsAgentId: JOURNEY_ELEVENLABS.agentId,
      resendDomains: [JOURNEY_HOSTS.sendingDomain, JOURNEY_HOSTS.replyDomain],
    });
    teardown.stub = stub;
    stubWiring = {
      proxyPort: stub.proxyPort,
      certificatePath: certificate.certificatePath,
    };
    stubControlOrigin = `http://127.0.0.1:${String(stub.controlPort)}`;
  }

  if (process.env.E2E_SKIP_BUILD !== "1") {
    execFileSync("npm", ["run", "build:server"], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    execFileSync("npm", ["run", "build"], {
      cwd: join(repositoryRoot, "apps", "dashboard"),
      stdio: "inherit",
      env: { ...process.env, ...dashboardEnvironment({ endpoints }) },
    });
  }

  try {
    teardown.services.push(
      await startService({
        name: "build-agent-backend",
        command: process.execPath,
        args: [join(repositoryRoot, "dist", "index.js")],
        cwd: repositoryRoot,
        env: buildBackendEnvironment({
          endpoints,
          runDirectory,
          ...(stubWiring ? { stub: stubWiring } : {}),
        }),
        logPath: join(runDirectory, "logs", "build-agent-backend.log"),
        readyUrl: `http://127.0.0.1:${String(endpoints.buildBackendPort)}/health`,
        readyTimeoutMs: 60_000,
      }),
    );

    teardown.services.push(
      await startService({
        name: "general-orchestrator",
        command: process.execPath,
        args: [join(repositoryRoot, "dist", "orchestration-index.js")],
        cwd: repositoryRoot,
        env: orchestratorEnvironment({
          endpoints,
          runDirectory,
          ...(stubWiring ? { stub: stubWiring } : {}),
        }),
        logPath: join(runDirectory, "logs", "general-orchestrator.log"),
        readyUrl: `http://127.0.0.1:${String(endpoints.orchestratorPort)}/health`,
        readyInit: {
          headers: {
            authorization: `Bearer ${JOURNEY_SECRETS.orchestrationToken}`,
          },
        },
        readyTimeoutMs: 60_000,
      }),
    );

    teardown.services.push(
      await startService({
        name: "dashboard",
        command: "npx",
        args: [
          "next",
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(endpoints.dashboardPort),
        ],
        cwd: join(repositoryRoot, "apps", "dashboard"),
        env: { ...process.env, ...dashboardEnvironment({ endpoints }) },
        logPath: join(runDirectory, "logs", "dashboard.log"),
        readyUrl: `http://127.0.0.1:${String(endpoints.dashboardPort)}/healthz`,
        readyTimeoutMs: 120_000,
      }),
    );

    try {
      teardown.services.push(
        await startService({
          name: "voice-intake",
          command: "npx",
          args: [
            "vinext",
            "dev",
            "--host",
            "127.0.0.1",
            "--port",
            String(endpoints.voicePort),
          ],
          cwd: join(repositoryRoot, "apps", "voice-intake"),
          env: {
            ...process.env,
            ...voiceIntakeEnvironment({
              endpoints,
              ...(stubWiring ? { stub: stubWiring } : {}),
            }),
          },
          logPath: join(runDirectory, "logs", "voice-intake.log"),
          readyUrl: `http://127.0.0.1:${String(endpoints.voicePort)}/api/public-config`,
          readyTimeoutMs: 120_000,
        }),
      );
    } catch (error) {
      degradations.push(
        `voice-intake did not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const tlsFront = await startDashboardTlsFront({
      certificatePem: certificate.certificatePem,
      keyPem: certificate.keyPem,
      targetHost: "127.0.0.1",
      targetPort: endpoints.dashboardPort,
    });
    teardown.tlsFront = tlsFront;

    const runtime: JourneyRuntime = {
      mode: live ? "live" : "stub",
      runDirectory,
      audioFixturePath,
      origins: {
        buildBackend: `http://127.0.0.1:${String(endpoints.buildBackendPort)}`,
        orchestrator: `http://127.0.0.1:${String(endpoints.orchestratorPort)}`,
        dashboard: `http://127.0.0.1:${String(endpoints.dashboardPort)}`,
        voiceIntake: `http://127.0.0.1:${String(endpoints.voicePort)}`,
      },
      dashboardPublicOrigin: `https://${JOURNEY_HOSTS.dashboard}`,
      dashboardTlsPort: tlsFront.port,
      tokens: {
        buildBackend: JOURNEY_SECRETS.buildBackendToken,
        orchestrator: JOURNEY_SECRETS.orchestrationToken,
      },
      stubControlOrigin,
      secrets: {
        stripeWebhook: JOURNEY_SECRETS.stripeWebhookSecret,
        resendWebhook: JOURNEY_SECRETS.resendWebhookSecret,
        elevenLabsWebhook: JOURNEY_SECRETS.elevenLabsWebhookSecret,
      },
      degradations,
    };
    writeJourneyRuntime(runtime);
  } catch (error) {
    await runTeardown();
    throw error;
  }

  return runTeardown;
}

async function runTeardown(): Promise<void> {
  await stopServices(teardown.services);
  teardown.services = [];
  await teardown.tlsFront?.close();
  teardown.tlsFront = undefined;
  await teardown.stub?.close();
  teardown.stub = undefined;
}

async function freePort(preferred: number): Promise<number> {
  if (await isPortFree(preferred)) {
    return preferred;
  }
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePort(true));
    });
  });
}
