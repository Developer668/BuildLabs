import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson } from "../../lib/canonical-json.js";
import {
  assertDaytonaTelemetryEvent,
  classifyDaytonaFailure,
  type DaytonaContentFreeTelemetryEvent,
  type DaytonaFailureCode,
  type DaytonaTelemetrySink,
} from "./daytona-control-plane.js";

export class DaytonaJsonlTelemetry implements DaytonaTelemetrySink {
  #tail = Promise.resolve();
  #failureCode: DaytonaFailureCode | undefined;

  constructor(private readonly path: string) {
    if (!path || path.includes("\0")) {
      throw new Error("Daytona telemetry path is invalid");
    }
  }

  emit(event: DaytonaContentFreeTelemetryEvent): void {
    assertDaytonaTelemetryEvent(event);
    const serialized = `${canonicalJson(structuredClone(event))}\n`;
    this.#tail = this.#tail
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await appendFile(this.path, serialized, {
          encoding: "utf8",
          mode: 0o600,
        });
        await chmod(this.path, 0o600);
      })
      .catch((error: unknown) => {
        this.#failureCode = classifyDaytonaFailure(error);
      });
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  async flushOrThrow(): Promise<void> {
    await this.flush();
    if (this.#failureCode) {
      throw new Error(
        `Daytona persistent telemetry flush failed (${this.#failureCode})`,
      );
    }
  }

  failureCode(): DaytonaFailureCode | undefined {
    return this.#failureCode;
  }
}
