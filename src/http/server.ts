import { createReadStream, existsSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import type { AppConfig } from "../config.js";
import type { ElevenLabsSpeechEngine } from "../adapters/elevenlabs/elevenlabs-speech-engine.js";
import {
  artifactArchiveFilename,
  OutboxEventSchema,
} from "../domain/artifact.js";
import { BuildAssignmentSchema, Sha256Schema } from "../domain/contract.js";
import { canonicalJson, sha256 } from "../lib/canonical-json.js";
import { redactValue } from "../lib/redaction.js";
import { resolveArtifactFileForDownload } from "../adapters/filesystem/artifact-store.js";
import {
  IdempotencyConflictError,
  RunNotFoundError,
} from "../adapters/sqlite/run-store.js";
import type {
  CancellationRequest,
  CancellationResult,
  CodeReviewPort,
  ModelPort,
  RunStore,
  SandboxProvider,
  StudioToolTraceInput,
  TracePort,
  TraceSpan,
} from "../ports/index.js";
import { StudioCommandService } from "../application/studio-command-service.js";
import { observeBuildRunForCustomer } from "../application/customer-build-observability.js";
import {
  StudioSubagent,
  transcriptExplicitlyRequestsCancellation,
  type StudioTranscriptMessage,
} from "../application/studio-subagent.js";
import { createBuildRunAgUiHandler } from "./ag-ui.js";
export interface SchedulerControl {
  wake(): void;
  cancel(runId: string, request: CancellationRequest): CancellationResult;
}

const RunParamsSchema = z.object({ runId: z.uuid() });
const ArtifactParamsSchema = z.object({
  runId: z.uuid(),
  artifactId: z.uuid(),
});
const EventParamsSchema = z.object({ eventId: z.uuid() });
const EventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(1_000).default(250),
});
const CustomerObservabilityQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(250).default(100),
  })
  .strict();
const StudioRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(24),
    projectId: z.string().min(1).max(128).optional(),
  })
  .strict();
const OutboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1_000).default(100),
  projectId: z.string().min(1).max(128).optional(),
  runIds: z
    .string()
    .min(1)
    .max(4 * 37)
    .transform((value, context) => {
      const runIds = [...new Set(value.split(","))];
      if (
        runIds.length < 1 ||
        runIds.length > 4 ||
        runIds.some((runId) => !z.uuid().safeParse(runId).success)
      ) {
        context.addIssue({
          code: "custom",
          message: "runIds must contain one to four unique UUIDs",
        });
        return z.NEVER;
      }
      return runIds;
    })
    .optional(),
});
const ElevenLabsSystemConversationIdSchema = z
  .string()
  .regex(/^conv_[A-Za-z0-9_-]+$/)
  .max(256);
const StudioCandidateBodySchema = z
  .object({
    runId: z.uuid(),
    systemConversationId: ElevenLabsSystemConversationIdSchema,
  })
  .strict();
const StudioCancelBodySchema = StudioCandidateBodySchema.extend({
  systemConversationHistory: z
    .string()
    .min(1)
    .max(128 * 1_024),
  cancellationCapability: z.string().min(1).max(4_096),
}).strict();
const ElevenLabsConversationHistorySchema = z
  .object({
    "x-elevenlabs-history": z.literal(true),
    entries: z
      .array(
        z
          .object({
            role: z.enum(["user", "agent", "tool"]),
            message: z.string().min(1).max(32_000).optional(),
          })
          .passthrough(),
      )
      .max(100),
  })
  .strict();
const CancellationCapabilityPayloadSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    conversationCorrelationId: z.string().regex(/^[a-f0-9]{64}$/),
    expectedStatus: z.enum(["queued", "running"]),
    expectedUpdatedAt: z.iso.datetime(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type CancellationCapabilityPayload = z.infer<
  typeof CancellationCapabilityPayloadSchema
>;
const CANCELLATION_CAPABILITY_TTL_MS = 2 * 60_000;
const CANCELLATION_CAPABILITY_DOMAIN =
  "buildlabs-elevenlabs-cancel-capability-v1:";
const ProvenPreviewRequestSchema = z
  .object({
    eventId: z.uuid(),
    artifactId: z.uuid(),
    artifactSha256: Sha256Schema,
    revisionHash: Sha256Schema,
    expiresInSeconds: z.coerce
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 60 * 60),
  })
  .strict();
const ProviderIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);

export interface HttpServerDependencies {
  config: AppConfig;
  store: RunStore;
  scheduler: SchedulerControl;
  sandboxProvider: SandboxProvider;
  model: ModelPort;
  reviewer: CodeReviewPort;
  trace: TracePort;
  elevenLabs?: ElevenLabsSpeechEngine;
}

type SponsorName =
  | "braintrust"
  | "coderabbit"
  | "copilotkit"
  | "daytona"
  | "elevenlabs"
  | "fireworks";
type SponsorStatus =
  | "configured"
  | "end-to-end-verified"
  | "healthy"
  | "unconfigured"
  | "unhealthy";

interface SponsorStatusPayload {
  status: "ready" | "not_ready";
  providers: Record<SponsorName, SponsorStatus>;
  checkedAt?: string;
}

export function createHttpServer(
  dependencies: HttpServerDependencies,
): FastifyInstance {
  let providerProbeCache:
    | {
        expiresAt: number;
        statusCode: 200 | 503;
        payload: SponsorStatusPayload;
      }
    | undefined;
  let providerProbeInFlight:
    | Promise<{
        statusCode: 200 | 503;
        payload: SponsorStatusPayload;
      }>
    | undefined;
  const server = Fastify({
    logger: {
      level: dependencies.config.NODE_ENV === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 2 * 1_024 * 1_024,
    requestTimeout: 30_000,
  });
  const studioCommands = new StudioCommandService(
    dependencies.store,
    dependencies.scheduler,
  );
  const studioSubagent = new StudioSubagent(
    dependencies.model,
    studioCommands,
    dependencies.trace,
  );
  const activeAgUiStreams = new Set<AbortController>();
  const speechEngineAttachment = dependencies.elevenLabs?.attach(
    server.server,
    studioSubagent,
  );
  server.addHook("preClose", async () => {
    for (const controller of activeAgUiStreams) {
      controller.abort(new Error("BuildLabs backend is shutting down"));
    }
    activeAgUiStreams.clear();
    if (speechEngineAttachment) {
      await speechEngineAttachment.close();
    }
    const flush = await settleWithin(
      Promise.resolve().then(() => dependencies.trace.flush()),
      5_000,
    );
    if (flush.status !== "fulfilled") {
      server.log.warn(
        {
          status: flush.status,
          ...(flush.status === "rejected"
            ? { error: redactValue(flush.reason) }
            : {}),
        },
        "Braintrust trace flush did not complete during shutdown",
      );
    }
  });

  server.addHook("onRequest", async (request, reply) => {
    if (isElevenLabsToolRequest(request.url)) {
      if (
        !dependencies.config.ELEVENLABS_TOOL_SECRET ||
        !dependencies.config.ELEVENLABS_CAPABILITY_SECRET
      ) {
        await reply.code(503).send({
          error: "integration_unconfigured",
          message: "The ElevenLabs webhook tool bridge is not configured",
        });
        return;
      }
      if (
        !validBearerToken(request, dependencies.config.ELEVENLABS_TOOL_SECRET)
      ) {
        await reply.code(401).send({
          error: "unauthorized",
          message: "A valid ElevenLabs tool bearer token is required",
        });
      }
      return;
    }
    if (
      request.url === "/" ||
      request.url === "/health" ||
      request.url === "/ready" ||
      request.url === "/studio" ||
      request.url.startsWith("/studio/") ||
      !dependencies.config.BUILDLABS_INTERNAL_TOKEN
    ) {
      return;
    }
    if (
      !validBearerToken(request, dependencies.config.BUILDLABS_INTERNAL_TOKEN)
    ) {
      await reply.code(401).send({
        error: "unauthorized",
        message: "A valid internal bearer token is required",
      });
    }
  });

  server.get("/health", () => ({
    status: "ok",
    component: "build-agent-backend",
  }));

  server.get("/ready", (_request, reply) => {
    const providers = configuredSponsorStatuses(dependencies);
    // ElevenLabs is optional in configuration, so an install without voice must
    // still become ready. Only a provider this service cannot run without can
    // hold readiness down.
    const ready = Object.entries(providers).every(
      ([name, status]) =>
        status !== "unconfigured" || OPTIONAL_SPONSORS.has(name as SponsorName),
    );
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      providers,
    } satisfies SponsorStatusPayload);
  });

  registerStudioShell(server);

  server.get("/v1/studio/runs", (request) => {
    const { limit, projectId } = StudioRunsQuerySchema.parse(request.query);
    const runs = dependencies.store.listRecent(limit, projectId).map((run) => {
      const assignment = dependencies.store.getAssignment(run.id);
      const evidence = dependencies.store.listEvidence(run.id);
      const events = dependencies.store.listEvents(run.id, 0);
      const hardRequirements =
        assignment?.contract.requirements.filter(
          (requirement) => requirement.priority === "hard",
        ).length ?? 0;
      return {
        run,
        assignment: assignment
          ? {
              strategyLabel: assignment.strategyLabel,
              requestedAt: assignment.requestedAt,
              limits: assignment.limits,
              contract: {
                contractId: assignment.contract.contractId,
                contractRevision: assignment.contract.contractRevision,
                approvedAt: assignment.contract.approvedAt,
                approvedFacts: assignment.contract.approvedFacts.map(
                  (fact) => ({
                    id: fact.id,
                    statement: fact.statement,
                  }),
                ),
                forbiddenClaims: assignment.contract.forbiddenClaims,
                requirements: assignment.contract.requirements.map(
                  (requirement) => ({
                    id: requirement.id,
                    description: requirement.description,
                    priority: requirement.priority,
                    verifierKinds: requirement.verifiers.map(
                      (verifier) => verifier.kind,
                    ),
                  }),
                ),
              },
            }
          : null,
        activity: {
          eventCount: events.length,
          latestEvent: events.at(-1) ?? null,
        },
        proof: {
          total: evidence.length,
          passed: evidence.filter((receipt) => receipt.status === "PASS")
            .length,
          failed: evidence.filter((receipt) => receipt.status === "FAIL")
            .length,
          errors: evidence.filter((receipt) => receipt.status === "ERROR")
            .length,
          hardRequirements,
        },
        artifactAvailable: dependencies.store.getArtifact(run.id) !== undefined,
        previewAvailable:
          run.sandboxId !== undefined && run.previewPort !== undefined,
      };
    });
    return {
      runs,
      generatedAt: new Date().toISOString(),
    };
  });

  server.post("/v1/integrations/probe", async (_request, reply) => {
    if (providerProbeCache && providerProbeCache.expiresAt > Date.now()) {
      return reply
        .code(providerProbeCache.statusCode)
        .send(providerProbeCache.payload);
    }
    providerProbeInFlight ??= probeSponsorProviders(dependencies).finally(
      () => {
        providerProbeInFlight = undefined;
      },
    );
    const result = await providerProbeInFlight;
    providerProbeCache = {
      ...result,
      expiresAt: Date.now() + 60_000,
    };
    return reply.code(result.statusCode).send(result.payload);
  });

  server.post("/v1/build-runs", async (request, reply) => {
    const assignment = BuildAssignmentSchema.parse(request.body);
    const result = dependencies.store.createRun(assignment);
    dependencies.scheduler.wake();
    return reply
      .header("Location", `/v1/build-runs/${result.run.id}`)
      .code(result.created ? 202 : 200)
      .send({
        created: result.created,
        run: result.run,
      });
  });

  server.get("/v1/build-runs/:runId", (request) => {
    const { runId } = RunParamsSchema.parse(request.params);
    const run = requireRun(dependencies.store, runId);
    return {
      run,
      artifact: dependencies.store.getArtifact(runId) ?? null,
    };
  });

  server.get(
    "/v1/build-runs/:runId/artifacts/:artifactId",
    async (request, reply) => {
      const { runId, artifactId } = ArtifactParamsSchema.parse(request.params);
      const run = requireRun(dependencies.store, runId);
      const artifact = dependencies.store.getArtifact(runId);
      if (
        run.status !== "passed" ||
        !artifact ||
        artifact.artifactId !== artifactId
      ) {
        return reply.code(404).send({
          error: "artifact_not_found",
          message: "A proven artifact with this identity was not found",
        });
      }

      let artifactPath: string;
      try {
        artifactPath = await resolveArtifactFileForDownload(
          dependencies.config.BUILDLABS_ARTIFACT_DIR,
          artifact,
        );
      } catch (error) {
        server.log.warn(
          { error: redactValue(error), runId, artifactId },
          "Proven artifact failed its download integrity check",
        );
        return reply.code(409).send({
          error: "artifact_unavailable",
          message: "The proven artifact failed its integrity check",
        });
      }

      return reply
        .type("application/gzip")
        .header("Content-Length", artifact.sizeBytes)
        .header(
          "Content-Disposition",
          `attachment; filename="${artifactArchiveFilename(artifact)}"`,
        )
        .header("ETag", `"${artifact.sha256}"`)
        .header("X-Artifact-SHA256", artifact.sha256)
        .send(createReadStream(artifactPath));
    },
  );

  server.get("/v1/build-runs/:runId/events", (request) => {
    const { runId } = RunParamsSchema.parse(request.params);
    requireRun(dependencies.store, runId);
    const { after, limit } = EventsQuerySchema.parse(request.query);
    const events = dependencies.store.listEvents(runId, after, limit);
    const nextAfter = events.at(-1)?.sequence ?? after;
    return {
      events,
      nextAfter,
      hasMore: nextAfter < dependencies.store.getLatestEventSequence(runId),
    };
  });

  server.get("/v1/build-runs/:runId/customer-observability", (request) => {
    const { runId } = RunParamsSchema.parse(request.params);
    const run = requireRun(dependencies.store, runId);
    const { after, limit } = CustomerObservabilityQuerySchema.parse(
      request.query,
    );
    return observeBuildRunForCustomer(dependencies.store, run, {
      afterSequence: after,
      limit,
    });
  });

  server.post(
    "/v1/integrations/copilotkit/agent",
    createBuildRunAgUiHandler({
      store: dependencies.store,
      activeStreams: activeAgUiStreams,
    }),
  );

  server.get("/v1/build-runs/:runId/evidence", (request) => {
    const { runId } = RunParamsSchema.parse(request.params);
    requireRun(dependencies.store, runId);
    return {
      evidence: dependencies.store.listEvidence(runId),
    };
  });

  server.post(
    "/v1/build-runs/:runId/proven-preview",
    async (request, reply) => {
      const { runId } = RunParamsSchema.parse(request.params);
      const run = requireRun(dependencies.store, runId);
      const provenPreviewRequest = ProvenPreviewRequestSchema.parse(
        request.body,
      );
      const idempotencyKey = ProviderIdempotencyKeySchema.parse(
        requiredHeader(request, "idempotency-key"),
      );
      const pendingEventResult = OutboxEventSchema.safeParse(
        dependencies.store.getPendingOutbox(provenPreviewRequest.eventId),
      );
      const artifact = dependencies.store.getArtifact(runId);
      if (
        run.status !== "passed" ||
        !pendingEventResult.success ||
        !artifact ||
        pendingEventResult.data.runId !== runId ||
        pendingEventResult.data.payload.runId !== runId ||
        pendingEventResult.data.revisionHash !== run.revisionHash ||
        pendingEventResult.data.payload.contractHash !== run.contractHash ||
        pendingEventResult.data.payload.sandboxId !== run.sandboxId ||
        pendingEventResult.data.payload.previewPort !== run.previewPort ||
        pendingEventResult.data.payload.artifact.artifactId !==
          provenPreviewRequest.artifactId ||
        pendingEventResult.data.payload.artifact.sha256 !==
          provenPreviewRequest.artifactSha256 ||
        pendingEventResult.data.revisionHash !==
          provenPreviewRequest.revisionHash ||
        artifact.artifactId !== provenPreviewRequest.artifactId ||
        artifact.sha256 !== provenPreviewRequest.artifactSha256 ||
        artifact.revisionHash !== provenPreviewRequest.revisionHash ||
        artifact.daytonaSnapshot !==
          pendingEventResult.data.payload.artifact.daytonaSnapshot
      ) {
        return reply.code(409).send({
          error: "proven_preview_not_available",
          message:
            "The pending proven event does not match this exact frozen artifact",
        });
      }

      const previewRequestedAt = Date.now();
      const preview =
        await dependencies.sandboxProvider.materializeFrozenPreview(
          {
            snapshotId: artifact.daytonaSnapshot,
            runId,
            eventId: pendingEventResult.data.eventId,
            artifactId: artifact.artifactId,
            artifactSha256: artifact.sha256,
            revisionHash: artifact.revisionHash,
            port: pendingEventResult.data.payload.previewPort,
            expiresInSeconds: provenPreviewRequest.expiresInSeconds,
            idempotencyKey,
          },
          request.signal,
        );
      if (
        !validFrozenPreviewTarget(
          preview,
          previewRequestedAt,
          provenPreviewRequest.expiresInSeconds,
        ) ||
        !dependencies.store.getPendingOutbox(provenPreviewRequest.eventId)
      ) {
        return reply.code(409).send({
          error: "proven_preview_not_available",
          message:
            "The frozen preview provider or pending proof identity could not be verified",
        });
      }
      return {
        kind: "frozen_proven_preview",
        eventId: pendingEventResult.data.eventId,
        runId,
        artifactId: artifact.artifactId,
        revisionHash: artifact.revisionHash,
        artifactSha256: artifact.sha256,
        snapshotId: artifact.daytonaSnapshot,
        ...preview,
      };
    },
  );

  server.get("/v1/build-runs/:runId/preview", async (request, reply) => {
    const { runId } = RunParamsSchema.parse(request.params);
    const run = requireRun(dependencies.store, runId);
    if (!["running", "passed"].includes(run.status)) {
      return reply.code(409).send({
        error: "preview_not_ready",
        message: "The candidate preview is not available for this run state",
      });
    }
    const previewPort =
      run.previewPort ??
      dependencies.store.getAssignment(runId)?.contract.verification
        .previewPort;
    if (!run.sandboxId || !previewPort) {
      return reply.code(409).send({
        error: "preview_not_ready",
        message: "The candidate preview is not available yet",
      });
    }
    const preview = await dependencies.sandboxProvider.getPreview(
      run.sandboxId,
      previewPort,
      300,
      request.signal,
    );
    return {
      kind: "ephemeral_daytona_preview",
      ...preview,
    };
  });

  server.post("/v1/build-runs/:runId/cancel", async (request, reply) => {
    const { runId } = RunParamsSchema.parse(request.params);
    requireRun(dependencies.store, runId);
    const cancellation = dependencies.scheduler.cancel(runId, {
      source: "operator_api",
      reasonCode: "operator_api_cancellation",
    });
    return reply.code(202).send({
      run: cancellation.run,
    });
  });

  server.get("/v1/integrations", () => {
    const configured = configuredSponsorStatuses(dependencies);
    const status = providerProbeCache?.payload.providers ?? configured;
    return {
      status,
      lastProbeAt: providerProbeCache?.payload.checkedAt ?? null,
      probeEndpoint: "/v1/integrations/probe",
      daytona: {
        status: status.daytona,
        responsibility: "isolated-build-and-preview",
      },
      fireworks: {
        status: status.fireworks,
        responsibility: "inference-and-training",
      },
      braintrust: {
        status: status.braintrust,
        responsibility: "observability-and-evaluation",
      },
      coderabbit: {
        status: status.coderabbit,
        responsibility: "candidate-code-review",
      },
      copilotkit: {
        status: status.copilotkit,
        backendStatus: "configured",
        transport: "ag-ui",
        endpoint: "/v1/integrations/copilotkit/agent",
      },
      elevenlabs: {
        status: status.elevenlabs,
        backendStatus: "configured",
        speechEngineStatus: dependencies.elevenLabs
          ? "configured"
          : "unconfigured",
        speechEngineEndpoint: "/v1/integrations/elevenlabs/speech-engine",
        webRtcTokenEndpoint: "/v1/integrations/elevenlabs/webrtc-token",
        webhookToolsStatus:
          dependencies.config.ELEVENLABS_TOOL_SECRET &&
          dependencies.config.ELEVENLABS_CAPABILITY_SECRET
            ? "configured"
            : "unconfigured",
        webhookTools: {
          getCandidate: "/v1/integrations/elevenlabs/tools/get-candidate",
          getCandidateEvidence:
            "/v1/integrations/elevenlabs/tools/get-candidate-evidence",
          cancelCandidate: "/v1/integrations/elevenlabs/tools/cancel-candidate",
        },
        webhookDynamicVariables: {
          systemConversationId: "system__conversation_id",
          systemConversationHistory: "system__conversation_history",
        },
      },
    };
  });

  server.post(
    "/v1/integrations/elevenlabs/webrtc-token",
    async (request, reply) => {
      if (!dependencies.config.BUILDLABS_INTERNAL_TOKEN) {
        return reply.code(503).send({
          error: "integration_unconfigured",
          message:
            "The internal API token is required before minting voice session tokens",
        });
      }
      if (
        !validBearerToken(request, dependencies.config.BUILDLABS_INTERNAL_TOKEN)
      ) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "A valid internal bearer token is required",
        });
      }
      if (!dependencies.elevenLabs) {
        return reply.code(503).send({
          error: "integration_unconfigured",
          message: "The ElevenLabs Speech Engine is not configured",
        });
      }
      const token = await dependencies.elevenLabs.createWebRtcToken();
      return reply.header("Cache-Control", "no-store").send(token);
    },
  );

  server.post(
    "/v1/integrations/elevenlabs/tools/get-candidate",
    async (request) => {
      const { runId, systemConversationId } = StudioCandidateBodySchema.parse(
        request.body,
      );
      return runStudioToolTrace(
        dependencies.trace,
        studioToolTraceInput("get_candidate", runId, systemConversationId),
        (span) => {
          requireRun(dependencies.store, runId);
          const candidate = studioCommands.getCandidate(runId);
          span?.log({
            output: {
              runId,
              status: candidate.status,
              cancelRequested: candidate.cancelRequested,
              artifactAvailable: candidate.artifactAvailable,
              previewAvailable: candidate.previewAvailable,
            },
          });
          if (
            !candidate.cancelRequested &&
            (candidate.status === "queued" || candidate.status === "running")
          ) {
            return {
              ...candidate,
              cancellationCapability: issueCancellationCapability(
                {
                  runId,
                  conversationCorrelationId:
                    studioConversationCorrelationId(systemConversationId),
                  expectedStatus: candidate.status,
                  expectedUpdatedAt: candidate.updatedAt,
                },
                dependencies.config.ELEVENLABS_CAPABILITY_SECRET!,
              ),
            };
          }
          return candidate;
        },
      );
    },
  );

  server.post(
    "/v1/integrations/elevenlabs/tools/get-candidate-evidence",
    async (request) => {
      const { runId, systemConversationId } = StudioCandidateBodySchema.parse(
        request.body,
      );
      return runStudioToolTrace(
        dependencies.trace,
        studioToolTraceInput(
          "get_candidate_evidence",
          runId,
          systemConversationId,
        ),
        (span) => {
          requireRun(dependencies.store, runId);
          const evidence = studioCommands.getEvidenceSummary(runId);
          span?.log({
            output: {
              runId,
              receiptCount: evidence.receiptCount,
              proven: evidence.proven,
              statusCounts: evidence.byStatus,
            },
          });
          return evidence;
        },
      );
    },
  );

  server.post(
    "/v1/integrations/elevenlabs/tools/cancel-candidate",
    async (request) => {
      const {
        runId,
        systemConversationId,
        systemConversationHistory,
        cancellationCapability,
      } = StudioCancelBodySchema.parse(request.body);
      return runStudioToolTrace(
        dependencies.trace,
        studioToolTraceInput("cancel_candidate", runId, systemConversationId),
        (span) => {
          requireRun(dependencies.store, runId);
          const candidate = studioCommands.getCandidate(runId);
          const capability = verifyCancellationCapability(
            cancellationCapability,
            dependencies.config.ELEVENLABS_CAPABILITY_SECRET!,
            runId,
            systemConversationId,
          );
          const explicitCancellationRequested =
            transcriptExplicitlyRequestsCancellation(
              parseElevenLabsConversationHistory(systemConversationHistory),
            );
          if (!capability || !explicitCancellationRequested) {
            const rejected = {
              changed: false,
              reason: "cancellation_intent_not_verified",
              candidate,
            };
            span?.log({
              output: {
                runId,
                changed: false,
                decision: rejected.reason,
                status: candidate.status,
              },
            });
            return rejected;
          }
          const cancellation = studioCommands.cancelCandidate(
            runId,
            capability.expectedStatus,
            capability.expectedUpdatedAt,
            {
              source: "elevenlabs_webhook",
              conversationId: systemConversationId,
            },
          );
          span?.log({
            output: {
              runId,
              changed: cancellation.changed,
              decision: cancellation.reason,
              status: cancellation.candidate.status,
            },
          });
          return cancellation;
        },
      );
    },
  );

  server.get("/v1/outbox", (request) => {
    const { limit, projectId, runIds } = OutboxQuerySchema.parse(request.query);
    return {
      events: dependencies.store.listOutbox(limit, projectId, runIds),
    };
  });

  server.post("/v1/outbox/:eventId/ack", async (request, reply) => {
    const { eventId } = EventParamsSchema.parse(request.params);
    if (!dependencies.store.markOutboxPublished(eventId)) {
      return reply.code(404).send({
        error: "outbox_event_not_found",
        message: "The outbox event does not exist",
      });
    }
    return reply.code(204).send();
  });

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(400).send({
        error: "invalid_request",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof RunNotFoundError) {
      void reply.code(404).send({
        error: "run_not_found",
        message: error.message,
      });
      return;
    }
    if (error instanceof IdempotencyConflictError) {
      void reply.code(409).send({
        error: "idempotency_conflict",
        message: error.message,
      });
      return;
    }

    server.log.error(
      { error: redactValue(error) },
      "Unhandled HTTP request failure",
    );
    void reply.code(500).send({
      error: "internal_error",
      message: "The build-agent backend could not complete the request",
    });
  });

  return server;
}

/** Sponsors whose absence is a supported configuration, not a fault. */
const OPTIONAL_SPONSORS = new Set<SponsorName>(["elevenlabs"]);

function configuredSponsorStatuses(
  dependencies: HttpServerDependencies,
): Record<SponsorName, SponsorStatus> {
  return {
    daytona: "configured",
    fireworks: "configured",
    braintrust: "configured",
    coderabbit: "configured",
    copilotkit: "configured",
    elevenlabs: dependencies.elevenLabs ? "configured" : "unconfigured",
  };
}

async function probeSponsorProviders(
  dependencies: HttpServerDependencies,
): Promise<{ statusCode: 200 | 503; payload: SponsorStatusPayload }> {
  const signal = AbortSignal.timeout(20_000);
  const probes: Array<readonly [SponsorName, () => Promise<void>]> = [
    ["daytona", () => dependencies.sandboxProvider.health(signal)],
    ["fireworks", () => dependencies.model.health(signal)],
    ["coderabbit", () => dependencies.reviewer.health(signal)],
    ["braintrust", () => dependencies.trace.health(signal)],
  ];
  if (dependencies.elevenLabs) {
    probes.push(["elevenlabs", () => dependencies.elevenLabs!.health(signal)]);
  }
  const outcomes = await Promise.allSettled(
    probes.map(([, operation]) => Promise.resolve().then(operation)),
  );
  const providers = configuredSponsorStatuses(dependencies);
  outcomes.forEach((outcome, index) => {
    const name = probes[index]?.[0];
    if (name) {
      providers[name] =
        outcome.status === "fulfilled" ? "healthy" : "unhealthy";
    }
  });
  const ready = Object.entries(providers).every(
    ([name, status]) =>
      status !== "unhealthy" &&
      (status !== "unconfigured" || OPTIONAL_SPONSORS.has(name as SponsorName)),
  );
  return {
    statusCode: ready ? 200 : 503,
    payload: {
      status: ready ? "ready" : "not_ready",
      providers,
      checkedAt: new Date().toISOString(),
    },
  };
}

function requireRun(store: RunStore, runId: string) {
  const run = store.getRun(runId);
  if (!run) {
    throw new RunNotFoundError(runId);
  }
  return run;
}

function validBearerToken(
  request: FastifyRequest,
  expectedToken: string,
): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isElevenLabsToolRequest(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path?.startsWith("/v1/integrations/elevenlabs/tools/") ?? false;
}

function studioConversationCorrelationId(conversationId: string): string {
  return sha256(`studio-conversation:${conversationId}`);
}

function issueCancellationCapability(
  input: Omit<CancellationCapabilityPayload, "version" | "expiresAt">,
  secret: string,
): string {
  const payload: CancellationCapabilityPayload = {
    version: 1,
    ...input,
    expiresAt: Date.now() + CANCELLATION_CAPABILITY_TTL_MS,
  };
  const encodedPayload = Buffer.from(canonicalJson(payload), "utf8").toString(
    "base64url",
  );
  const signature = cancellationCapabilitySignature(encodedPayload, secret);
  return `v1.${encodedPayload}.${signature.toString("base64url")}`;
}

function verifyCancellationCapability(
  token: string,
  secret: string,
  runId: string,
  systemConversationId: string,
): CancellationCapabilityPayload | undefined {
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== "v1" ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? "")
  ) {
    return undefined;
  }
  const encodedPayload = parts[1]!;
  const expectedSignature = cancellationCapabilitySignature(
    encodedPayload,
    secret,
  );
  const suppliedSignature = Buffer.from(parts[2]!, "base64url");
  if (
    suppliedSignature.length !== expectedSignature.length ||
    suppliedSignature.toString("base64url") !== parts[2] ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return undefined;
  }

  let decoded: unknown;
  try {
    const payloadBytes = Buffer.from(encodedPayload, "base64url");
    if (
      payloadBytes.length > 2_048 ||
      payloadBytes.toString("base64url") !== encodedPayload
    ) {
      return undefined;
    }
    decoded = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = CancellationCapabilityPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    return undefined;
  }
  const now = Date.now();
  if (
    parsed.data.runId !== runId ||
    parsed.data.conversationCorrelationId !==
      studioConversationCorrelationId(systemConversationId) ||
    parsed.data.expiresAt < now ||
    parsed.data.expiresAt > now + CANCELLATION_CAPABILITY_TTL_MS
  ) {
    return undefined;
  }
  return parsed.data;
}

function cancellationCapabilitySignature(
  encodedPayload: string,
  secret: string,
): Buffer {
  return createHmac("sha256", secret)
    .update(CANCELLATION_CAPABILITY_DOMAIN)
    .update(encodedPayload)
    .digest();
}

function parseElevenLabsConversationHistory(
  serializedHistory: string,
): StudioTranscriptMessage[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serializedHistory);
  } catch {
    return [];
  }
  const parsed = ElevenLabsConversationHistorySchema.safeParse(decoded);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.entries.flatMap<StudioTranscriptMessage>((entry) => {
    if (!entry.message || (entry.role !== "user" && entry.role !== "agent")) {
      return [];
    }
    return [
      {
        role: entry.role,
        content: entry.message,
      },
    ];
  });
}

function studioToolTraceInput(
  tool: StudioToolTraceInput["tool"],
  runId: string,
  conversationId: string,
): StudioToolTraceInput {
  return {
    tool,
    runId,
    conversationCorrelationId: sha256(`studio-conversation:${conversationId}`),
  };
}

function runStudioToolTrace<T>(
  trace: TracePort,
  input: StudioToolTraceInput,
  operation: (span: TraceSpan | undefined) => T | Promise<T>,
): Promise<T> {
  if (trace.studioTool) {
    return trace.studioTool(input, (span) => Promise.resolve(operation(span)));
  }
  return Promise.resolve(operation(undefined));
}

type Settlement =
  | { status: "fulfilled" }
  | { status: "rejected"; reason: unknown }
  | { status: "timed-out" };

function settleWithin(
  promise: Promise<void>,
  timeoutMilliseconds: number,
): Promise<Settlement> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: Settlement): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(outcome);
    };
    const timeout = setTimeout(() => {
      finish({ status: "timed-out" });
    }, timeoutMilliseconds);
    timeout.unref();
    void promise.then(
      () => {
        finish({ status: "fulfilled" });
      },
      (reason: unknown) => {
        finish({ status: "rejected", reason });
      },
    );
  });
}

function requiredHeader(request: FastifyRequest, name: string): string {
  return z.string().min(1).parse(request.headers[name]);
}

function validFrozenPreviewTarget(
  preview: { url: string; expiresAt: string },
  requestedAt: number,
  expiresInSeconds: number,
): boolean {
  try {
    const url = new URL(preview.url);
    const expiresAt = Date.parse(preview.expiresAt);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      Number.isFinite(expiresAt) &&
      expiresAt > requestedAt &&
      expiresAt <= Date.now() + expiresInSeconds * 1_000 + 5_000
    );
  } catch {
    return false;
  }
}

function registerStudioShell(server: FastifyInstance): void {
  const studioRoot = resolve(process.cwd(), "dist", "studio");
  const indexPath = resolve(studioRoot, "index.html");
  if (!existsSync(indexPath)) {
    return;
  }

  void server.register(fastifyStatic, {
    root: studioRoot,
    prefix: "/studio/",
    decorateReply: false,
    index: ["index.html"],
  });
  server.get("/", (_request, reply) => reply.redirect("/studio/"));
  server.get("/studio", (_request, reply) => reply.redirect("/studio/"));
  server.addHook("onSend", (request, reply, payload, done) => {
    if (request.url === "/studio" || request.url.startsWith("/studio/")) {
      void reply
        .header("Cache-Control", "no-store")
        .header("Cross-Origin-Opener-Policy", "same-origin")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Security-Policy",
          [
            "default-src 'self'",
            "connect-src 'self' http://127.0.0.1:* http://localhost:* https:",
            "frame-src 'self' https:",
            "img-src 'self' data: https:",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
          ].join("; "),
        );
    }
    done(null, payload);
  });
}
