import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import {
  BuildAssignmentSchema,
  type BuildAssignment,
} from "../src/domain/contract.js";
import { sha256 } from "../src/lib/canonical-json.js";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const API_ORIGIN =
  process.env.BUILD_BACKEND_BASE_URL ?? "http://127.0.0.1:3000";
const INTERNAL_TOKEN =
  process.env.BUILD_BACKEND_INTERNAL_TOKEN ??
  process.env.BUILDLABS_INTERNAL_TOKEN ??
  "";
const runTag = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const nonce = randomBytes(3).toString("hex");

const strategies = [
  {
    id: "editorial",
    label: "editorial clarity",
    direction:
      "Use a strong editorial hierarchy, crisp typography, and restrained color.",
  },
  {
    id: "product",
    label: "product-led workflow",
    direction:
      "Make the interactive workflow the visual center, with compact product-like navigation.",
  },
  {
    id: "accessible",
    label: "accessibility-first",
    direction:
      "Prioritize keyboard flow, visible focus, high contrast, clear validation, and reduced motion.",
  },
  {
    id: "expressive",
    label: "expressive brand system",
    direction:
      "Create a distinctive but professional brand system with thoughtful responsive composition.",
  },
] as const;

const projects = [
  {
    slug: "northstar-scheduling",
    name: "Northstar Scheduling",
    purpose: "helps teams request appointments",
    workflow:
      "an appointment request form with service selection, preferred date, contact details, validation, and an in-browser confirmation state",
    disclaimer: "The demo does not connect to a real scheduling system.",
  },
  {
    slug: "harbor-counsel",
    name: "Harbor Counsel Workspace",
    purpose: "helps people organize a fictional intake checklist",
    workflow:
      "an intake checklist with matter-type selection, document readiness toggles, progress feedback, and an in-browser summary",
    disclaimer: "The demo is not a law firm and does not provide legal advice.",
  },
  {
    slug: "cascade-home",
    name: "Cascade Home Services",
    purpose: "helps homeowners compare fictional home-service options",
    workflow:
      "a service comparison flow with category filters, an estimate range explainer, a saved shortlist, and an in-browser request summary",
    disclaimer:
      "The demo does not provide real estimates or connect to service providers.",
  },
  {
    slug: "civic-garden",
    name: "Civic Garden Directory",
    purpose: "helps neighbors explore fictional community garden listings",
    workflow:
      "a searchable garden directory with amenity filters, availability states, a favorites list, and an in-browser visit plan",
    disclaimer:
      "The garden names, locations, availability, and contact details are fictional.",
  },
] as const;

async function main(): Promise<void> {
  if (INTERNAL_TOKEN.length < 16) {
    throw new Error("A build-backend internal token is required");
  }

  const requestedSlugs = new Set(
    (process.argv[2] ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
  );
  const selectedProjects =
    requestedSlugs.size === 0
      ? projects
      : projects.filter((project) => requestedSlugs.has(project.slug));
  if (selectedProjects.length !== requestedSlugs.size) {
    const available = projects.map((project) => project.slug).join(", ");
    throw new Error(
      `Unknown demo project slug; available projects: ${available}`,
    );
  }

  const assignments = selectedProjects.flatMap((project) =>
    strategies.map((strategy) => assignmentFor(project, strategy)),
  );
  const results: Array<{
    projectId: string;
    candidateId: string;
    runId: string;
    created: boolean;
  }> = [];

  for (const assignment of assignments) {
    const response = await fetch(new URL("/v1/build-runs", API_ORIGIN), {
      method: "POST",
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": `demo-seed:${assignment.assignmentId}`,
      },
      body: JSON.stringify(assignment),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as {
      created?: unknown;
      run?: { id?: unknown };
      error?: unknown;
      message?: unknown;
    };
    if (
      !response.ok ||
      typeof body.created !== "boolean" ||
      typeof body.run?.id !== "string"
    ) {
      const detail =
        typeof body.message === "string"
          ? body.message
          : typeof body.error === "string"
            ? body.error
            : "invalid response";
      throw new Error(
        `Build dispatch failed with ${response.status}: ${detail}`,
      );
    }
    results.push({
      projectId: assignment.projectId,
      candidateId: assignment.candidateId,
      runId: body.run.id,
      created: body.created,
    });
  }

  process.stdout.write(`${JSON.stringify({ runTag, results }, null, 2)}\n`);
}

function assignmentFor(
  project: (typeof projects)[number],
  strategy: (typeof strategies)[number],
): BuildAssignment {
  const projectId = `demo-${project.slug}-${runTag}-${nonce}`;
  const transcript = [
    "Agent: This is a fictional BuildLabs demonstration. What should the site show?",
    `Customer: The project is named ${project.name}.`,
    `Customer: ${project.name} is a fictional BuildLabs demonstration project.`,
    `Customer: ${project.name} ${project.purpose}.`,
    `Customer: ${project.disclaimer}`,
    `Customer: Build ${project.workflow}.`,
    "Agent: I will keep every customer and business detail clearly labeled as fictional demo data.",
  ].join("\n");
  const transcriptSha256 = sha256(transcript);
  const factStatements = [
    `${project.name} is a fictional BuildLabs demonstration project.`,
    `${project.name} ${project.purpose}.`,
    project.disclaimer,
  ];

  return BuildAssignmentSchema.parse({
    assignmentId: `${projectId}-${strategy.id}`,
    projectId,
    candidateId: `${project.slug}-${strategy.id}`,
    requestedAt: new Date().toISOString(),
    strategyLabel: strategy.label,
    buildPrompt: [
      `Build a polished, responsive website for ${project.name}.`,
      'This is explicitly fictional demo data. Keep the exact disclosure "Fictional demo data" visible on the homepage.',
      `The primary experience must be ${project.workflow}.`,
      strategy.direction,
      "Use only facts from the supplied transcript and Acceptance Contract.",
      "Do not use remote images, analytics, external APIs, or network-dependent fonts.",
      "The workflow must work locally in the browser without claiming that data was sent or saved.",
      "Include accessible semantic HTML, mobile and desktop layouts, keyboard support, visible focus, loading/empty/error/success states where relevant, and polished original CSS.",
      "Emit a production Dockerfile. The app must listen on 0.0.0.0:3000, expose GET /health with a 200 response containing ok, and define npm run build, npm test, and npm run start.",
    ].join("\n"),
    transcript: {
      content: transcript,
      sha256: transcriptSha256,
    },
    contract: {
      version: 1,
      contractRevision: 1,
      contractId: `${projectId}-v1`,
      projectId,
      transcriptSha256,
      approvedAt: new Date().toISOString(),
      approvedFacts: factStatements.map((statement, index) => {
        const excerpt =
          index === 0
            ? `${project.name} is a fictional BuildLabs demonstration project.`
            : index === 1
              ? `${project.name} ${project.purpose}.`
              : project.disclaimer;
        const startOffset = transcript.indexOf(excerpt);
        return {
          id: `fact-${index + 1}`,
          statement,
          sources: [
            {
              type: "transcript" as const,
              transcriptSha256,
              startOffset,
              endOffset: startOffset + excerpt.length,
              excerpt,
              excerptSha256: sha256(excerpt),
            },
          ],
        };
      }),
      forbiddenClaims: [
        "real customer",
        "real business",
        "submitted successfully",
        "saved to our servers",
        "guaranteed result",
      ],
      requirements: [
        {
          id: "project-name",
          description: `The homepage visibly names ${project.name}.`,
          priority: "hard",
          verifiers: [
            {
              kind: "http",
              path: "/",
              expectedStatus: 200,
              bodyIncludes: [project.name],
            },
          ],
        },
        {
          id: "fictional-disclosure",
          description:
            "The homepage visibly discloses that the content is fictional demo data.",
          priority: "hard",
          verifiers: [
            {
              kind: "http",
              path: "/",
              expectedStatus: 200,
              bodyIncludes: ["Fictional demo data"],
            },
          ],
        },
        {
          id: "health",
          description: "The service exposes a healthy local HTTP endpoint.",
          priority: "hard",
          verifiers: [
            {
              kind: "http",
              path: "/health",
              expectedStatus: 200,
              bodyIncludes: ["ok"],
            },
          ],
        },
        {
          id: "delivery-files",
          description:
            "The project includes the package manifest and production Dockerfile required for delivery.",
          priority: "hard",
          verifiers: [
            {
              kind: "command",
              command: "test -s package.json && test -s Dockerfile",
              timeoutSeconds: 30,
            },
          ],
        },
        {
          id: "experience-quality",
          description:
            "The result is a distinctive, responsive, accessible interactive experience rather than a static placeholder.",
          priority: "preference",
          verifiers: [
            {
              kind: "semantic",
              criterion:
                "The rendered app has a polished responsive hierarchy and a complete interactive workflow.",
            },
          ],
        },
      ],
      verification: {
        buildCommand: "npm run build",
        testCommands: ["npm test"],
        previewCommand: "npm run start",
        previewPort: 3000,
      },
    },
    sandbox: {
      language: "typescript",
      snapshot: process.env.DAYTONA_BUILD_SNAPSHOT,
      autoStopMinutes: 120,
      autoArchiveMinutes: 1_440,
    },
    limits: {
      maxAgentSteps: 40,
      maxRepairRounds: 2,
      wallClockSeconds: 3_600,
      maxToolOutputBytes: 65_536,
    },
  });
}

await main();
