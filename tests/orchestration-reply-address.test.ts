import { describe, expect, it } from "vitest";

import {
  InvalidReplyAddressError,
  ReplyAddressCodec,
} from "../src/orchestration/application/reply-address.js";

describe("ReplyAddressCodec", () => {
  it("round-trips an opaque project-scoped reply address", () => {
    const codec = new ReplyAddressCodec({
      domain: "reply.buildlapse.example",
      secret: Buffer.alloc(32, 7),
    });

    const projectId = "11111111-2222-4333-8444-555555555555";
    const address = codec.create(projectId);
    expect(address).not.toContain(projectId);
    expect(codec.parse(address)).toBe(projectId);
  });

  it("rejects another domain or a tampered token", () => {
    const codec = new ReplyAddressCodec({
      domain: "reply.buildlapse.example",
      secret: Buffer.alloc(32, 7),
    });
    const address = codec.create("11111111-2222-4333-8444-555555555555");
    const at = address.indexOf("@");
    const original = address[at - 1];
    const tampered = `${address.slice(0, at - 1)}${original === "x" ? "y" : "x"}${address.slice(at)}`;

    expect(() => codec.parse(tampered)).toThrow(InvalidReplyAddressError);
    expect(() =>
      codec.parse(address.replace("reply.buildlapse.example", "evil.example")),
    ).toThrow(InvalidReplyAddressError);
  });
});
