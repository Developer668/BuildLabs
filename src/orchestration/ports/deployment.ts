import type { OutboxEvent } from "../../domain/artifact.js";
import type { ValidatedProvenArtifact } from "./build-backend.js";

export interface DeployProvenArtifactRequest {
  event: OutboxEvent;
  artifact: ValidatedProvenArtifact;
}

export interface FlyDeploymentReceipt {
  provider: "fly";
  appName: string;
  releaseKey: string;
  projectId: string;
  candidateId: string;
  contractHash: string;
  revisionHash: string;
  sourceArtifactSha256: string;
  workspaceSha256: string;
  flyReleaseId: string;
  flyReleaseVersion: number;
  imageDigest: string;
  machineIds: readonly string[];
  machineInstanceIds: readonly string[];
  verifiedLabels: {
    releaseKey: string;
    artifactSha256: string;
  };
  deploymentAttempted: boolean;
  recoveredFromProvider: boolean;
  productionUrl: string;
  deployedAt: string;
  releaseVerifiedAt: string;
  healthVerifiedAt: string;
  healthAttempts: number;
}

export interface FlyDeploymentPort {
  /**
   * Verifies the Fly token/org through the read-only Apps API and confirms the
   * configured flyctl binary is executable.
   */
  health(signal?: AbortSignal): Promise<void>;
  deployProvenArtifact(
    request: DeployProvenArtifactRequest,
    signal?: AbortSignal,
  ): Promise<FlyDeploymentReceipt>;
}
