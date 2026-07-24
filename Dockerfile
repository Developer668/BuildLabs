# syntax=docker/dockerfile:1.7
#
# BuildLabs Node services (build-agent backend + general orchestrator).
#
# One image serves both Node services; the entrypoint is chosen at run time so
# each Fly app can start a different process from the same digest:
#
#   build-agent-backend  ->  node dist/index.js               (127.0.0.1:3000 by default)
#   general-orchestrator ->  node dist/orchestration-index.js (127.0.0.1:3100 by default)
#
# Each fly.*.toml sets its own command through `[processes]`, which overrides
# the CMD below while keeping the tini ENTRYPOINT. `dist/production-index.js`
# (the supervisor that runs both services in one process tree) is present but
# deliberately NOT the default: on Fly each service is its own app so it can be
# scaled, exposed, and restarted independently.
#
# Build from the repository root (npm workspace + lockfile live here):
#   docker build -t buildlabs-node .

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
# deps - root workspace dependencies, including devDependencies for the build
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV CI=true \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

# The workspace manifests are required for `npm ci` to reproduce the lockfile
# tree, even though the workspace packages themselves are not installed here.
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/voice-intake/package.json ./apps/voice-intake/package.json

# `--workspaces=false --include-workspace-root` installs only the root package.
# The Next.js dashboard and the Cloudflare Worker are built by their own
# pipelines (apps/dashboard/Dockerfile and wrangler) and are dead weight here.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces=false --include-workspace-root

# ---------------------------------------------------------------------------
# build - compile src/ to dist/ and bundle the operator studio shell
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY studio ./studio

# build:server emits dist/{index,orchestration-index,production-index}.js.
# build:studio emits dist/studio, which src/http/server.ts mounts at /studio
# when the directory exists (it is skipped silently otherwise).
RUN npm run build:server \
    && npm run build:studio

# ---------------------------------------------------------------------------
# prod-deps - the same lockfile tree with devDependencies omitted
# ---------------------------------------------------------------------------
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspaces=false --include-workspace-root

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG GIT_REVISION=unknown
ARG INSTALL_FLYCTL=true
ARG INSTALL_CODERABBIT_CLI=true
ARG CODERABBIT_INSTALL_ROOT=/opt/coderabbit

LABEL org.opencontainers.image.title="BuildLabs Node services" \
      org.opencontainers.image.description="BuildLabs build-agent backend and general orchestrator (Fastify, Node 24)" \
      org.opencontainers.image.source="https://github.com/Developer668/BuildLabs" \
      org.opencontainers.image.documentation="https://github.com/Developer668/BuildLabs/blob/main/docs/DEPLOYMENT.md" \
      org.opencontainers.image.vendor="BuildLabs" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.base.name="docker.io/library/node:24-bookworm-slim" \
      org.opencontainers.image.revision="${GIT_REVISION}"

# git   - the CodeRabbit adapter materializes a trusted review repository and
#         shells out to `git` (src/adapters/coderabbit/coderabbit-cli.ts).
# tini  - reaps the orphaned children left by flyctl/coderabbit/git spawns,
#         since Node runs as PID 1 on Fly Machines.
# curl/ca-certificates - provider HTTPS calls and the CLI installers below.
# Debian package versions are intentionally unpinned; the base image tag pins
# the distribution and security updates should be picked up on rebuild.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        tini \
    && rm -rf /var/lib/apt/lists/*

# A piped installer must fail the build when the download fails, so the shell
# needs pipefail; /bin/sh is dash on Debian and does not support it.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# flyctl is required by the ORCHESTRATOR only: it deploys proven customer
# projects (src/orchestration/adapters/build/fly-cli-deployment.ts). The image
# ships the binary; the FLY_ACCESS_TOKEN that makes it useful is set as a Fly
# secret on the orchestrator app alone and must never reach a build sandbox.
RUN if [ "${INSTALL_FLYCTL}" = "true" ]; then \
        curl -fsSL https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sh \
        && flyctl version; \
    fi

# The CodeRabbit CLI is required by the BUILD-AGENT only. Credentials are never
# baked in: the runtime authenticates through CODERABBIT_AUTH_HOME, a
# pre-authenticated home directory on the mounted volume. Skip with
# `--build-arg INSTALL_CODERABBIT_CLI=false` and point CODERABBIT_BIN elsewhere
# if you vendor the binary yourself.
RUN if [ "${INSTALL_CODERABBIT_CLI}" = "true" ]; then \
        mkdir -p "${CODERABBIT_INSTALL_ROOT}" \
        && HOME="${CODERABBIT_INSTALL_ROOT}" sh -c 'curl -fsSL https://cli.coderabbit.ai/install.sh | sh' \
        && chmod -R a+rX "${CODERABBIT_INSTALL_ROOT}"; \
    fi
ENV PATH="/opt/coderabbit/.local/bin:${PATH}"

WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json

# The Daytona adapter re-hashes the provisioner source to verify the snapshot
# attestation before it will acquire a sandbox, so the script must exist at
# DAYTONA_PROVISIONER_SOURCE_PATH inside the image.
COPY scripts/provision-daytona-snapshot.ts ./scripts/provision-daytona-snapshot.ts

# /data is the Fly volume mount point for SQLite state and artifacts. Creating
# it here with `node` ownership lets the non-root runtime user write to a fresh
# volume; see docs/DEPLOYMENT.md for the chown fallback on existing volumes.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

# 3000 = build-agent backend, 3100 = general orchestrator.
EXPOSE 3000 3100

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
