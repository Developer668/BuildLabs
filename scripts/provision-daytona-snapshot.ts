import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import {
  Daytona,
  DaytonaNotFoundError,
  Image,
  type Sandbox,
} from "@daytona/sdk";

import {
  ensureDockerRuntime,
  inspectRenderedPagesInDaytonaSandbox,
} from "../src/adapters/daytona/daytona-sandbox.js";
import { loadConfig } from "../src/config.js";

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

let snapshot: Awaited<ReturnType<typeof daytona.snapshot.get>> | undefined;
try {
  snapshot = await daytona.snapshot.get(snapshotName);
} catch (error) {
  if (!(error instanceof DaytonaNotFoundError)) {
    throw error;
  }
}
if (!snapshot) {
  const image = Image.base("docker:28.3.3-dind")
    .runCommands(
      "apk add --no-cache bash build-base ca-certificates chromium coreutils curl findutils git grep jq nodejs npm openssh-client procps python3 py3-pip tar",
    )
    .runCommands(
      "npm install --prefix /opt/buildlabs-render-inspector --omit=dev --ignore-scripts --no-audit --no-fund playwright-core@1.61.1",
    )
    .runCommands("git config --system init.defaultBranch main")
    .workdir("/home/daytona");
  snapshot = await daytona.snapshot.create(
    {
      name: snapshotName,
      image,
      resources: { cpu: 2, memory: 4, disk: 10 },
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
  snapshot.cpu < 2 ||
  snapshot.mem < 4 ||
  snapshot.disk < 8
) {
  throw new Error(
    `Snapshot ${snapshotName} is not active with the required resources`,
  );
}

let probe: Sandbox | undefined;
let signedPreviewIngress:
  | {
      httpStatus: 200;
      visibleMarker: "passed";
      loopbackBinding: "passed";
    }
  | undefined;
try {
  probe = await daytona.create(
    {
      snapshot: snapshotName,
      language: "typescript",
      envVars: { CI: "true" },
      labels: { "buildlabs.probe": "docker-runtime" },
      public: false,
      autoStopInterval: 10,
      autoArchiveInterval: 30,
      ttlMinutes: 30,
    },
    { timeout: 180 },
  );
  const workDir = (await probe.getWorkDir()) ?? ".";
  await ensureDockerRuntime(probe, workDir, AbortSignal.timeout(90_000));
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

  await probe.updateNetworkSettings({ networkBlockAll: true });
  const sealedDocker = await probe.process.executeCommand(
    [
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
    ].join("\n"),
    workDir,
    {},
    60,
  );
  if (sealedDocker.exitCode !== 0) {
    throw new Error(
      "Daytona network seal did not block external Docker egress while preserving local Docker execution",
    );
  }
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
  const signedPreview = await probe.getSignedPreviewUrl(4_173, 60);
  try {
    let response: Response;
    try {
      response = await fetch(signedPreview.url, {
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
} finally {
  await probe?.delete(180, true);
}

if (!signedPreviewIngress) {
  throw new Error("Daytona signed preview ingress was not verified");
}

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
    networkSeal: {
      policy: "networkBlockAll",
      directIpDockerEgress: "blocked",
      registryDomainDockerEgress: "blocked",
      loopbackDockerAndChromium: "passed",
    },
  })}\n`,
);
