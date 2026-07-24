import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";

import {
  Daytona,
  DaytonaNotFoundError,
  Image,
  type Sandbox,
} from "@daytona/sdk";

import {
  cleanupFailedDaytonaSandbox,
  ensureDockerRuntime,
  inspectRenderedPagesInDaytonaSandbox,
} from "../src/adapters/daytona/daytona-sandbox.js";
import { installDaytonaScriptFailureRedaction } from "../src/adapters/daytona/daytona-script-safety.js";
import {
  createDaytonaSnapshotAttestation,
  daytonaProvisionerSourceDigest,
  DAYTONA_PINNED_SNAPSHOT_INPUTS,
  writeDaytonaSnapshotAttestation,
} from "../src/adapters/daytona/daytona-snapshot-attestation.js";
import { loadConfig } from "../src/config.js";
import { digestJson, sha256 } from "../src/lib/canonical-json.js";

installDaytonaScriptFailureRedaction("provision_snapshot");

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const config = loadConfig();
const daytona = new Daytona({
  apiKey: config.DAYTONA_API_KEY,
  apiUrl: config.DAYTONA_API_URL,
  ...(config.DAYTONA_TARGET ? { target: config.DAYTONA_TARGET } : {}),
  otelEnabled: config.DAYTONA_OTEL_ENABLED,
});
const snapshotName = config.DAYTONA_BUILD_SNAPSHOT;

async function main(): Promise<void> {
  const phaseMs: Record<string, number> = {};
  const provisionerSourceSha256 = daytonaProvisionerSourceDigest(
    await readFile(new URL(import.meta.url)),
  );
  const image = Image.base(DAYTONA_PINNED_SNAPSHOT_INPUTS.baseImage)
    .runCommands(
      `apk add --no-cache ${DAYTONA_PINNED_SNAPSHOT_INPUTS.alpinePackages.join(" ")}`,
    )
    .runCommands(
      `npm install --prefix /opt/buildlabs-render-inspector --omit=dev --ignore-scripts --no-audit --no-fund playwright-core@${DAYTONA_PINNED_SNAPSHOT_INPUTS.playwrightCoreVersion}`,
    )
    .runCommands("git config --system init.defaultBranch main")
    .workdir("/home/daytona");

  let snapshot: Awaited<ReturnType<typeof daytona.snapshot.get>> | undefined;
  const snapshotAcquisitionStarted = performance.now();
  try {
    snapshot = await daytona.snapshot.get(snapshotName);
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) {
      throw error;
    }
  }
  if (!snapshot) {
    snapshot = await daytona.snapshot.create(
      {
        name: snapshotName,
        image,
        resources: {
          cpu: DAYTONA_PINNED_SNAPSHOT_INPUTS.resources.cpu,
          memory: DAYTONA_PINNED_SNAPSHOT_INPUTS.resources.memoryGiB,
          disk: DAYTONA_PINNED_SNAPSHOT_INPUTS.resources.diskGiB,
        },
      },
      {
        timeout: 900,
        onLogs: (chunk) => {
          const line = chunk.split("\n").at(-1)?.trim();
          if (line && /^(Creating|Created) snapshot/.test(line)) {
            process.stdout.write(`${line}\n`);
          }
        },
      },
    );
  }

  if (
    snapshot.state !== "active" ||
    snapshot.cpu !== DAYTONA_PINNED_SNAPSHOT_INPUTS.resources.cpu ||
    snapshot.mem !== DAYTONA_PINNED_SNAPSHOT_INPUTS.resources.memoryGiB ||
    snapshot.disk !== DAYTONA_PINNED_SNAPSHOT_INPUTS.resources.diskGiB
  ) {
    throw new Error(
      `Snapshot ${snapshotName} is not active with the daytona-large resource profile`,
    );
  }
  phaseMs.snapshot_acquisition = elapsed(snapshotAcquisitionStarted);

  let probe: Sandbox | undefined;
  let chromiumVersion: string | undefined;
  let dockerServerVersion: string | undefined;
  let signedPreviewIngress:
    | {
        httpStatus: 200;
        visibleMarker: "passed";
        loopbackBinding: "passed";
      }
    | undefined;
  let metricsProbe:
    | {
        latest: "passed";
        historical: "passed";
        historicalSampleCount: number;
      }
    | { latest: "failed"; historical: "failed" };
  let probeFailure: unknown;
  try {
    const probeAcquisitionStarted = performance.now();
    probe = await daytona.create(
      {
        snapshot: snapshotName,
        language: "typescript",
        envVars: { CI: "true" },
        labels: {
          "buildlabs.owner": "buildlabs-controller",
          "buildlabs.managed": "true",
          "buildlabs.role": "verifier-delivery",
          "buildlabs.purpose": "snapshot-provision-probe",
        },
        public: false,
        autoStopInterval: 10,
        autoArchiveInterval: 30,
        ttlMinutes: 30,
      },
      { timeout: 180 },
    );
    phaseMs.probe_acquisition = elapsed(probeAcquisitionStarted);
    const workDir = (await probe.getWorkDir()) ?? ".";
    const dockerReadinessStarted = performance.now();
    await ensureDockerRuntime(probe, workDir, AbortSignal.timeout(90_000));
    const runtimeVersions = await probe.process.executeCommand(
      [
        "set -euo pipefail",
        "printf 'chromium='",
        "chromium --version",
        "printf 'docker='",
        "docker version --format '{{.Server.Version}}'",
      ].join("\n"),
      workDir,
      {},
      30,
    );
    if (runtimeVersions.exitCode !== 0) {
      throw new Error(
        "Daytona snapshot runtime versions could not be measured",
      );
    }
    const versionLines = (runtimeVersions.result ?? "").trim().split("\n");
    chromiumVersion = versionLines
      .find((line) => line.startsWith("chromium="))
      ?.slice("chromium=".length)
      .trim();
    dockerServerVersion = versionLines
      .find((line) => line.startsWith("docker="))
      ?.slice("docker=".length)
      .trim();
    if (!chromiumVersion || !dockerServerVersion) {
      throw new Error("Daytona snapshot runtime version output was malformed");
    }
    phaseMs.docker_readiness = elapsed(dockerReadinessStarted);
    const hiddenTextHtml = [
      "<!doctype html>",
      "<style>",
      ".proof { display: none; }",
      ".offscreen { position: absolute; left: -9999px; }",
      ".transparent { color: transparent; }",
      ".same-color { color: rgb(0 0 0); background: rgb(0 0 0); }",
      ".low-opacity { opacity: 0.05; }",
      ".covered { position: relative; width: max-content; }",
      ".covered > .overlay { position: absolute; inset: 0; background: white; }",
      ".churn { color: transparent; }",
      ".marker-reactive { color: rgb(0 0 0); background: rgb(0 0 0); }",
      ".monkey-hidden { display: none; }",
      ".partial-clip { width: 100px; overflow: hidden; white-space: nowrap; font: 16px monospace; }",
      "</style>",
      "<main>Visible Render Probe</main>",
      '<span class="proof">Display Hidden Required</span>',
      '<span class="offscreen">Offscreen Hidden Required</span>',
      '<span class="transparent">Transparent Hidden Required</span>',
      '<span class="same-color">Same Color Hidden Required</span>',
      '<span class="low-opacity">Low Opacity Hidden Required</span>',
      '<div class="covered">Overlay Hidden Required<span class="overlay"></span></div>',
      '<span class="churn">Churn Hidden Required</span>',
      '<div class="marker-reactive">Marker Reactive Hidden Required</div>',
      '<div class="observer-status"></div>',
      '<div class="monkey-hidden">Monkeypatched Hidden Required</div>',
      '<div class="state-race">Visible Innocuous State 0</div>',
      '<div class="partial-clip">ClipPrefix Overflow Hidden Required</div>',
      "<script>",
      "const markerReactive = document.querySelector('.marker-reactive');",
      "const observerStatus = document.querySelector('.observer-status');",
      "const markerObserver = new MutationObserver(() => {",
      "  const markerPresent = Array.from(document.querySelectorAll('*')).some((element) =>",
      "    element.getAttributeNames().some((name) => name.startsWith('data-buildlabs-text-'))",
      "  );",
      "  markerReactive.style.backgroundColor = markerPresent ? 'white' : 'black';",
      "});",
      "markerObserver.observe(document.documentElement, { attributes: true, subtree: true });",
      "observerStatus.textContent = 'Marker Observer Armed';",
      "if (new URLSearchParams(location.search).has('race')) {",
      "  const stateRace = document.querySelector('.state-race');",
      "  let raceCounter = 0;",
      "  function churnState() {",
      "    raceCounter += 1;",
      "    stateRace.textContent = raceCounter % 2 === 0",
      "      ? `Visible Innocuous State ${raceCounter}`",
      "      : `State Race Hidden Required ${raceCounter}`;",
      "    setTimeout(churnState, 0);",
      "  }",
      "  churnState();",
      "}",
      "const nativeCreateRange = Document.prototype.createRange;",
      "Document.prototype.createRange = function createRangeTrap() {",
      "  return nativeCreateRange.call(this);",
      "};",
      "document.createRange = () => nativeCreateRange.call(document);",
      "Range.prototype.getClientRects = () => [{ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 }];",
      "Element.prototype.checkVisibility = () => true;",
      "</script>",
    ].join("");
    const browserFixturePath = "/tmp/buildlabs-render-probe.html";
    await probe.fs.uploadFile(
      Buffer.from(hiddenTextHtml, "utf8"),
      browserFixturePath,
    );
    const dockerBuildStarted = performance.now();
    const dockerBuild = await probe.process.executeCommand(
      [
        "tmp=$(mktemp -d)",
        `cp ${browserFixturePath} "$tmp/index.html"`,
        `printf '%s\\n' 'FROM alpine:3.22' 'RUN apk add --no-cache curl' 'CMD ["sh","-c","printf dind-ok"]' > "$tmp/Dockerfile"`,
        'docker build -q -t buildlabs-dind-probe "$tmp" >/dev/null',
        `printf '%s\\n' 'FROM alpine:3.22' 'RUN apk add --no-cache python3 && mkdir -p /www' 'COPY index.html /www/index.html' 'CMD ["python3","-m","http.server","4173","--bind","0.0.0.0","--directory","/www"]' > "$tmp/Dockerfile"`,
        'docker build -q -t buildlabs-render-probe-image "$tmp" >/dev/null',
        'rm -rf "$tmp"',
      ].join(" && "),
      workDir,
      {},
      240,
    );
    if (dockerBuild.exitCode !== 0) {
      throw new Error("Daytona Docker image build probe failed");
    }
    phaseMs.docker_build = elapsed(dockerBuildStarted);

    const networkSealStarted = performance.now();
    await probe.updateNetworkSettings({ networkBlockAll: true });
    const sealedDockerCommand = [
      "set -euo pipefail",
      "if docker run --rm --pull never --entrypoint curl buildlabs-dind-probe --silent --show-error --insecure --noproxy '*' --connect-timeout 3 --max-time 5 https://1.1.1.1/ >/dev/null 2>&1; then",
      "  echo 'networkBlockAll allowed nested Docker egress' >&2",
      "  exit 91",
      "fi",
      "if docker run --rm --pull never --entrypoint curl buildlabs-dind-probe --silent --show-error --insecure --noproxy '*' --connect-timeout 3 --max-time 5 https://registry.npmjs.org/ >/dev/null 2>&1; then",
      "  echo 'networkBlockAll allowed nested Docker egress to registry.npmjs.org' >&2",
      "  exit 92",
      "fi",
      'test "$(docker run --rm --pull never buildlabs-dind-probe)" = dind-ok',
      "docker rm -f buildlabs-render-probe >/dev/null 2>&1 || true",
      "docker run -d --name buildlabs-render-probe --pull never -p 127.0.0.1:4173:4173 buildlabs-render-probe-image >/dev/null",
    ].join("\n");
    const sealedDocker = await probe.process.executeCommand(
      sealedDockerCommand,
      workDir,
      {},
      60,
    );
    if (sealedDocker.exitCode !== 0) {
      throw new Error(
        "Daytona network seal did not block external Docker egress while preserving local Docker execution",
      );
    }
    phaseMs.network_seal = elapsed(networkSealStarted);
    const snapshotRestartStarted = performance.now();
    await probe.stop(120);
    await probe.start(120);
    await probe.updateNetworkSettings({ networkBlockAll: true });
    await probe.refreshData();
    if (probe.networkBlockAll !== true) {
      throw new Error(
        "Daytona networkBlockAll policy did not survive controller reapplication",
      );
    }
    await ensureDockerRuntime(probe, workDir, AbortSignal.timeout(90_000));
    const restartedSealedDocker = await probe.process.executeCommand(
      sealedDockerCommand,
      workDir,
      {},
      60,
    );
    if (restartedSealedDocker.exitCode !== 0) {
      throw new Error(
        "Daytona network seal was not effective after the snapshot restart probe",
      );
    }
    phaseMs.snapshot_restart = elapsed(snapshotRestartStarted);
    const browserProofStarted = performance.now();
    const browserReady = await probe.process.executeCommand(
      [
        "for attempt in $(seq 1 30); do",
        "  if curl --silent --fail --output /dev/null http://127.0.0.1:4173/; then exit 0; fi",
        "  sleep 1",
        "done",
        "exit 1",
      ].join("\n"),
      workDir,
      {},
      40,
    );
    if (browserReady.exitCode !== 0) {
      const diagnostics = await probe.process.executeCommand(
        [
          "docker ps -a --filter name=buildlabs-render-probe --format '{{.Status}}'",
          "docker logs --tail 20 buildlabs-render-probe 2>&1 || true",
        ].join("\n"),
        workDir,
        {},
        15,
      );
      const diagnosticOutput =
        diagnostics.result ?? diagnostics.artifacts?.stdout ?? "";
      throw new Error(
        `Daytona rendered-page fixture did not become ready: ${diagnosticOutput.slice(0, 2_000)}`,
      );
    }
    const [rendered, raced] = await inspectRenderedPagesInDaytonaSandbox(
      probe,
      workDir,
      ["/", "/?race=1"],
      4_173,
      30_000,
    );
    if (
      !rendered ||
      rendered.status !== 200 ||
      !rendered.visibleText?.includes("Visible Render Probe") ||
      rendered.visibleText.includes("Display Hidden Required") ||
      rendered.visibleText.includes("Offscreen Hidden Required") ||
      rendered.visibleText.includes("Transparent Hidden Required") ||
      rendered.visibleText.includes("Same Color Hidden Required") ||
      rendered.visibleText.includes("Low Opacity Hidden Required") ||
      rendered.visibleText.includes("Overlay Hidden Required") ||
      rendered.visibleText.includes("Churn Hidden Required") ||
      rendered.visibleText.includes("Marker Reactive Hidden Required") ||
      rendered.visibleText.includes("Monkeypatched Hidden Required") ||
      rendered.visibleText.includes("State Race Hidden Required") ||
      rendered.visibleText.includes("Overflow Hidden Required") ||
      !rendered.visibleText.includes("Marker Observer Armed") ||
      !rendered.visibleText.includes("ClipPrefix") ||
      rendered.screenshotSha256s?.length !== 1 ||
      !/^[a-f0-9]{64}$/.test(rendered.screenshotSha256s[0] ?? "")
    ) {
      throw new Error(
        `Daytona Chromium renderer did not enforce visible-text proof: ${JSON.stringify(rendered)}`,
      );
    }
    if (
      !raced ||
      raced.status !== null ||
      !raced.error?.includes("script-freeze boundary")
    ) {
      throw new Error(
        `Daytona Chromium renderer did not fail closed on a stale DOM/pixel race: ${JSON.stringify(raced)}`,
      );
    }
    phaseMs.browser_proof = elapsed(browserProofStarted);
    const signedPreviewStarted = performance.now();
    const signedPreview = await probe.getSignedPreviewUrl(4_173, 60);
    try {
      let response: Response;
      try {
        response = await fetch(signedPreview.url, {
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error(
          "Daytona signed preview ingress did not reach the loopback-bound fixture",
        );
      }
      const responseBody = await response.text();
      if (
        response.status !== 200 ||
        !responseBody.includes("Visible Render Probe")
      ) {
        throw new Error(
          `Daytona signed preview ingress failed its marker probe with status ${response.status}`,
        );
      }
      signedPreviewIngress = {
        httpStatus: 200,
        visibleMarker: "passed",
        loopbackBinding: "passed",
      };
    } finally {
      await probe
        .expireSignedPreviewUrl(4_173, signedPreview.token)
        .catch(() => undefined);
    }
    phaseMs.signed_preview = elapsed(signedPreviewStarted);
    const metricsStarted = performance.now();
    try {
      await probe.getMetricsLatest();
      const historical = await probe.getMetrics(
        new Date(Date.now() - 10 * 60_000),
        new Date(),
      );
      metricsProbe = {
        latest: "passed",
        historical: "passed",
        historicalSampleCount: historical.length,
      };
    } catch {
      metricsProbe = {
        latest: "failed",
        historical: "failed",
      };
    }
    phaseMs.metrics = elapsed(metricsStarted);
  } catch (error) {
    probeFailure = error;
    throw error;
  } finally {
    if (probe) {
      const teardownStarted = performance.now();
      await cleanupFailedDaytonaSandbox(
        probe,
        probeFailure ?? new Error("Daytona provisioning probe completed"),
      );
      phaseMs.teardown = elapsed(teardownStarted);
    }
  }

  if (!signedPreviewIngress) {
    throw new Error("Daytona signed preview ingress was not verified");
  }
  if (!chromiumVersion || !dockerServerVersion) {
    throw new Error("Daytona snapshot runtime identity was not verified");
  }
  if (
    metricsProbe.latest !== "passed" ||
    metricsProbe.historical !== "passed"
  ) {
    throw new Error("Daytona resource metrics could not be verified");
  }
  snapshot = await daytona.snapshot.get(snapshotName);
  const buildInfo = snapshot.buildInfo;
  if (
    !buildInfo?.snapshotRef ||
    !buildInfo.dockerfileContent ||
    sha256(buildInfo.dockerfileContent) !== sha256(image.dockerfile)
  ) {
    throw new Error(
      "Daytona snapshot build inputs do not match the pinned provisioner image",
    );
  }
  const attestation = createDaytonaSnapshotAttestation({
    schema: "buildlabs.daytona.snapshot-attestation.v1",
    provisionerSourceSha256,
    imageInputs: DAYTONA_PINNED_SNAPSHOT_INPUTS,
    snapshot: {
      id: snapshot.id,
      name: snapshot.name,
      state: "active",
      ...(snapshot.imageName ? { imageName: snapshot.imageName } : {}),
      ...(snapshot.ref ? { ref: snapshot.ref } : {}),
      ...(snapshot.sandboxClass ? { sandboxClass: snapshot.sandboxClass } : {}),
      regionIds: [...(snapshot.regionIds ?? [])].sort(),
      resources: {
        cpu: snapshot.cpu,
        memoryGiB: snapshot.mem,
        diskGiB: snapshot.disk,
      },
      buildInfo: {
        snapshotRef: buildInfo.snapshotRef,
        dockerfileSha256: sha256(buildInfo.dockerfileContent),
        contextHashesSha256: digestJson(
          [...(buildInfo.contextHashes ?? [])].sort(),
        ),
      },
      createdAt: new Date(snapshot.createdAt).toISOString(),
      updatedAt: new Date(snapshot.updatedAt).toISOString(),
    },
    validation: {
      validatedAt: new Date().toISOString(),
      chromiumVersion,
      dockerServerVersion,
      dindReady: true,
      renderedChromiumProof: true,
      staleDomRaceBlocked: true,
      signedPreviewIngress: true,
      resourceMetrics: {
        latest: true,
        historical: true,
      },
      networkBlockAll: {
        directIpEgressBlocked: true,
        registryEgressBlocked: true,
        loopbackPreserved: true,
        reappliedAfterRestart: true,
      },
    },
  });
  await writeDaytonaSnapshotAttestation(
    config.DAYTONA_SNAPSHOT_ATTESTATION_PATH,
    attestation,
  );

  process.stdout.write(
    `${JSON.stringify({
      snapshot: snapshotName,
      status: "ready",
      resources: {
        cpu: snapshot.cpu,
        memoryGiB: snapshot.mem,
        diskGiB: snapshot.disk,
      },
      dockerBuildAndRun: "passed",
      chromiumRenderedVisibility: "passed",
      partiallyClippedSingleTextNode: "passed",
      candidateScriptFreeze: "passed",
      isolatedWorldPristineIntrinsics: "passed",
      markerObserverArmed: "passed",
      markerReactiveMutation: "blocked",
      staleStateRace: "blocked",
      signedPreviewIngress,
      metrics: metricsProbe,
      lifecycleEventTransport: "automatic_unobserved",
      sdkOtel: config.DAYTONA_OTEL_ENABLED
        ? "configured_unverified"
        : "unconfigured",
      phaseMs,
      networkSeal: {
        policy: "networkBlockAll",
        directIpDockerEgress: "blocked",
        registryDomainDockerEgress: "blocked",
        loopbackDockerAndChromium: "passed",
        reappliedAfterRestart: "passed",
      },
      attestation: {
        path: config.DAYTONA_SNAPSHOT_ATTESTATION_PATH,
        payloadSha256: attestation.payloadSha256,
      },
    })}\n`,
  );
}

try {
  await main();
} finally {
  await daytona[Symbol.asyncDispose]();
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
