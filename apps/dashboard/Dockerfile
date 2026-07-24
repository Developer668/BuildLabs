# syntax=docker/dockerfile:1.7
#
# BuildLabs customer + operator dashboard (Next.js 16, @buildlabs/dashboard).
#
# IMPORTANT: build from the REPOSITORY ROOT, not from apps/dashboard. This is an
# npm workspace, so the lockfile and the hoisted node_modules tree live at the
# root and Next.js traces its standalone output from there:
#
#   docker build -f apps/dashboard/Dockerfile -t buildlabs-dashboard .
#
# `fly deploy -c fly.dashboard.toml` already does this: fly.dashboard.toml sits
# at the repository root, so the root is the build context.
#
# Requires `output: "standalone"` in apps/dashboard/next.config.ts.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
# deps - root + dashboard workspace dependencies (devDependencies included so
# that Next.js, TypeScript, and Tailwind can run the production build)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV CI=true \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

COPY package.json package-lock.json ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/voice-intake/package.json ./apps/voice-intake/package.json

RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace @buildlabs/dashboard --include-workspace-root

# ---------------------------------------------------------------------------
# build - next build with output: "standalone"
# ---------------------------------------------------------------------------
FROM deps AS build
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    COPILOTKIT_TELEMETRY_DISABLED=true

COPY apps/dashboard ./apps/dashboard

# Only build-time inputs belong here. Every runtime value (tokens, upstream
# URLs) is read on the server at request time, so nothing secret is baked in.
RUN npm run build --workspace @buildlabs/dashboard

# Normalize the standalone bundle into /standalone so the runtime stage has a
# fixed layout: /standalone/apps/dashboard/server.js next to /standalone/node_modules.
# Next.js infers the file-tracing root from the nearest lockfile/node_modules
# above the project. Inside this image that is /app, but if it ever resolves
# higher the bundle is emitted under a nested mirror of the absolute path, so
# the app subtree is hoisted back to the top here instead of silently shipping
# a broken image.
# hadolint ignore=DL3003
RUN set -eu; \
    root=/app/apps/dashboard/.next/standalone; \
    entry="$(find "$root" -path '*/apps/dashboard/server.js' -print -quit)"; \
    [ -n "$entry" ] || { echo "standalone server.js was not emitted"; exit 1; }; \
    traced="$(cd "$(dirname "$entry")/../.." && pwd)"; \
    mkdir -p /standalone; \
    cp -a "$root/." /standalone/; \
    if [ "$traced" != "$root" ]; then \
        rel="${traced#"$root"/}"; \
        cp -a "/standalone/$rel/." /standalone/; \
        rm -rf "/standalone/${rel%%/*}"; \
    fi; \
    cp -a /app/apps/dashboard/.next/static /standalone/apps/dashboard/.next/static; \
    test -f /standalone/apps/dashboard/server.js

# ---------------------------------------------------------------------------
# runtime - minimal standalone server
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG GIT_REVISION=unknown

LABEL org.opencontainers.image.title="BuildLabs dashboard" \
      org.opencontainers.image.description="BuildLabs customer and operator dashboard (Next.js 16 standalone)" \
      org.opencontainers.image.source="https://github.com/Developer668/BuildLabs" \
      org.opencontainers.image.documentation="https://github.com/Developer668/BuildLabs/blob/main/docs/DEPLOYMENT.md" \
      org.opencontainers.image.vendor="BuildLabs" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.base.name="docker.io/library/node:24-bookworm-slim" \
      org.opencontainers.image.revision="${GIT_REVISION}"

# Debian package versions are intentionally unpinned; the base image tag pins
# the distribution and security updates should be picked up on rebuild.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    COPILOTKIT_TELEMETRY_DISABLED=true \
    PORT=3200 \
    HOSTNAME=0.0.0.0

# The normalized bundle already contains the traced node_modules subset, the
# prerendered pages, and .next/static.
COPY --from=build --chown=node:node /standalone ./

# apps/dashboard/public does not exist in this repository; add a COPY for it
# here if static assets are introduced later.

USER node

EXPOSE 3200

# HOSTNAME=0.0.0.0 is required so the Fly proxy can reach the machine; the
# workspace `npm start` script binds 127.0.0.1 for single-host development.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/dashboard/server.js"]
