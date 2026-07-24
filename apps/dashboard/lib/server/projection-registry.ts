export interface CustomerBuilderFence {
  projectAlias: string;
  internalProjectId: string;
  builderAlias: string;
  runId: string;
  candidateId: string;
  contractVersion: number;
  sessionBinding: string;
  registeredAt: number;
}

const MAX_FENCES = 512;
const FENCE_TTL_MS = 15 * 60 * 1_000;

export class CustomerProjectionRegistry {
  readonly #fences = new Map<string, CustomerBuilderFence>();

  replaceProjectFences(
    projectAlias: string,
    sessionBinding: string,
    fences: readonly CustomerBuilderFence[],
    now = Date.now(),
  ): void {
    for (const [key, fence] of this.#fences) {
      if (
        fence.projectAlias === projectAlias &&
        fence.sessionBinding === sessionBinding
      ) {
        this.#fences.delete(key);
      }
    }
    for (const fence of fences) {
      this.#fences.set(this.#key(fence), { ...fence, registeredAt: now });
    }
    this.#evict(now);
  }

  get(
    projectAlias: string,
    builderAlias: string,
    sessionBinding: string,
    now = Date.now(),
  ): CustomerBuilderFence | undefined {
    this.#evict(now);
    return this.#fences.get(
      `${projectAlias}\0${builderAlias}\0${sessionBinding}`,
    );
  }

  clear(): void {
    this.#fences.clear();
  }

  clearSession(sessionBinding: string): void {
    for (const [key, fence] of this.#fences) {
      if (fence.sessionBinding === sessionBinding) {
        this.#fences.delete(key);
      }
    }
  }

  #key(fence: CustomerBuilderFence): string {
    return `${fence.projectAlias}\0${fence.builderAlias}\0${fence.sessionBinding}`;
  }

  #evict(now: number): void {
    for (const [key, fence] of this.#fences) {
      if (now - fence.registeredAt > FENCE_TTL_MS) {
        this.#fences.delete(key);
      }
    }
    while (this.#fences.size > MAX_FENCES) {
      const oldestKey = this.#fences.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.#fences.delete(oldestKey);
    }
  }
}

export const customerProjectionRegistry = new CustomerProjectionRegistry();
