import type { CustomerBuilderFence } from "./projection-registry";
import { DashboardBffError } from "./http";

const MAX_STORED_BYTES = 64 * 1024 * 1024;
const MAX_STORED_RENDERS = 128;

export interface CustomerWipFrameMetadata {
  frameId: string;
  capturedAt: string;
  expiresAt: string;
  stale: boolean;
  width: number;
  height: number;
}

export interface StoredCustomerWipFrame {
  projectId: string;
  runId: string;
  candidateId: string;
  contractVersion: number;
  frameId: string;
  capturedAt: string;
  expiresAtMs: number;
  storedAtMs: number;
  width: number;
  height: number;
  png: Buffer;
}

interface BlockedCustomerWipRender {
  projectId: string;
  runId: string;
  candidateId: string;
  contractVersion: number;
  blockedAtMs: number;
  expiresAtMs: number;
}

export class CustomerWipFrameStore {
  readonly #frames = new Map<string, StoredCustomerWipFrame>();
  readonly #blocked = new Map<string, BlockedCustomerWipRender>();
  #storedBytes = 0;

  put(
    frame: Omit<StoredCustomerWipFrame, "storedAtMs">,
    now = Date.now(),
    minimumIntervalMs = 0,
  ): CustomerWipFrameMetadata {
    this.#evict(now);
    const key = frameKey(frame);
    const previous = this.#frames.get(key);
    if (previous !== undefined) {
      if (
        frame.frameId !== previous.frameId &&
        now - previous.storedAtMs < minimumIntervalMs
      ) {
        throw new DashboardBffError(
          429,
          "wip_capture_rate_limited",
          "The WIP frame capture rate is limited",
        );
      }
      if (frame.frameId === previous.frameId) {
        return metadata(previous, now);
      }
      this.#storedBytes -= previous.png.byteLength;
      this.#frames.delete(key);
    }
    this.#blocked.delete(key);
    const stored: StoredCustomerWipFrame = {
      ...frame,
      storedAtMs: now,
      png: Buffer.from(frame.png),
    };
    this.#frames.set(key, stored);
    this.#storedBytes += stored.png.byteLength;
    this.#evict(now);
    return metadata(stored, now);
  }

  markBlocked(
    render: Omit<BlockedCustomerWipRender, "blockedAtMs">,
    now = Date.now(),
  ): void {
    this.#evict(now);
    const key = frameKey(render);
    const previous = this.#frames.get(key);
    if (previous !== undefined) {
      this.#frames.delete(key);
      this.#storedBytes -= previous.png.byteLength;
    }
    this.#blocked.delete(key);
    this.#blocked.set(key, { ...render, blockedAtMs: now });
    this.#evict(now);
  }

  isBlocked(fence: CustomerBuilderFence, now = Date.now()): boolean {
    this.#evict(now);
    return this.#blocked.has(frameKeyFromFence(fence));
  }

  get(
    fence: CustomerBuilderFence,
    frameId?: string,
    now = Date.now(),
  ): { metadata: CustomerWipFrameMetadata; png: Buffer } | undefined {
    this.#evict(now);
    const frame = this.#frames.get(frameKeyFromFence(fence));
    if (
      frame === undefined ||
      (frameId !== undefined && frame.frameId !== frameId)
    ) {
      return undefined;
    }
    return { metadata: metadata(frame, now), png: Buffer.from(frame.png) };
  }

  clear(): void {
    this.#frames.clear();
    this.#blocked.clear();
    this.#storedBytes = 0;
  }

  #evict(now: number): void {
    for (const [key, frame] of this.#frames) {
      if (frame.expiresAtMs <= now) {
        this.#frames.delete(key);
        this.#storedBytes -= frame.png.byteLength;
      }
    }
    for (const [key, render] of this.#blocked) {
      if (render.expiresAtMs <= now) {
        this.#blocked.delete(key);
      }
    }
    while (
      this.#frames.size + this.#blocked.size > MAX_STORED_RENDERS ||
      this.#storedBytes > MAX_STORED_BYTES
    ) {
      const oldestFrame = this.#frames.entries().next().value as
        [string, StoredCustomerWipFrame] | undefined;
      const oldestBlocked = this.#blocked.entries().next().value as
        [string, BlockedCustomerWipRender] | undefined;
      if (
        oldestFrame !== undefined &&
        (oldestBlocked === undefined ||
          oldestFrame[1].storedAtMs <= oldestBlocked[1].blockedAtMs)
      ) {
        this.#frames.delete(oldestFrame[0]);
        this.#storedBytes -= oldestFrame[1].png.byteLength;
      } else if (oldestBlocked !== undefined) {
        this.#blocked.delete(oldestBlocked[0]);
      } else {
        break;
      }
    }
  }
}

export const customerWipFrameStore = new CustomerWipFrameStore();

function metadata(
  frame: StoredCustomerWipFrame,
  now: number,
): CustomerWipFrameMetadata {
  return {
    frameId: frame.frameId,
    capturedAt: frame.capturedAt,
    expiresAt: new Date(frame.expiresAtMs).toISOString(),
    stale: now - Date.parse(frame.capturedAt) > 30_000,
    width: frame.width,
    height: frame.height,
  };
}

function frameKey(input: {
  projectId: string;
  runId: string;
  candidateId: string;
  contractVersion: number;
}): string {
  return [
    input.projectId,
    input.runId,
    input.candidateId,
    input.contractVersion,
  ].join("\0");
}

function frameKeyFromFence(fence: CustomerBuilderFence): string {
  return frameKey({
    projectId: fence.internalProjectId,
    runId: fence.runId,
    candidateId: fence.candidateId,
    contractVersion: fence.contractVersion,
  });
}
