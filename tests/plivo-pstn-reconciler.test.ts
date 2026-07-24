import { describe, expect, it } from "vitest";

import {
  BUILDLABS_PLIVO_PSTN_MANIFEST,
  PlivoPstnManifestSchema,
  type PlivoPstnManifest,
} from "../src/adapters/plivo/plivo-manifest.js";
import {
  type ElevenLabsBranchFence,
  type ElevenLabsSipAdminPort,
  type PlivoPstnAdminPort,
  type PlivoPstnBindings,
  PlivoPstnReconciler,
} from "../src/adapters/plivo/plivo-reconciler.js";

type JsonRecord = Record<string, unknown>;

const AUTH_ID = "authbuildlabs001";
const BINDINGS: PlivoPstnBindings = {
  plivoAuthId: AUTH_ID,
  plivoAuthToken: "plivo-token-at-least-twenty-bytes",
  reconciliationSecret: "plivo-reconciliation-secret-at-least-thirty-two-bytes",
  phoneNumber: "+15105550123",
  elevenLabsApiKey: "elevenlabs-key-at-least-twenty-bytes",
  agentId: "agent_buildlabs_plivo_001",
  branchId: "branch_buildlabs_plivo_testing_001",
  versionId: "version_buildlabs_plivo_testing_001",
};

class InMemoryPlivo implements PlivoPstnAdminPort {
  readonly mutations: string[] = [];
  readonly uris: JsonRecord[] = [];
  readonly trunks: JsonRecord[] = [];
  readonly numbers: JsonRecord[] = [
    {
      number: BINDINGS.phoneNumber.slice(1),
      active: true,
      voice_enabled: true,
      application: null,
      sms_enabled: true,
      mms_enabled: true,
    },
  ];
  beforeGetNumber?: (read: number, number: JsonRecord) => void;
  numberReads = 0;

  listOriginationUris() {
    return Promise.resolve(structuredClone(this.uris));
  }

  getOriginationUri(uriId: string) {
    const uri = this.uris.find((value) => value.uri_uuid === uriId);
    if (!uri) throw new Error("Unknown URI");
    return Promise.resolve(structuredClone(uri));
  }

  createOriginationUri(input: {
    name: string;
    uri: string;
    authentication_needed: false;
  }) {
    this.mutations.push("plivo:create_uri");
    const uriId = "11111111-1111-4111-8111-111111111111";
    this.uris.push({
      uri_uuid: uriId,
      ...structuredClone(input),
      username: "",
    });
    return Promise.resolve({ uriId });
  }

  updateOriginationUri(
    uriId: string,
    input: {
      name: string;
      uri: string;
      authentication_needed: false;
    },
  ) {
    this.mutations.push("plivo:update_uri");
    const index = this.uris.findIndex((value) => value.uri_uuid === uriId);
    if (index < 0) throw new Error("Unknown URI");
    this.uris[index] = { uri_uuid: uriId, ...structuredClone(input) };
    return Promise.resolve();
  }

  listTrunks() {
    return Promise.resolve(structuredClone(this.trunks));
  }

  getTrunk(trunkId: string) {
    const trunk = this.trunks.find((value) => value.trunk_id === trunkId);
    if (!trunk) throw new Error("Unknown trunk");
    return Promise.resolve(structuredClone(trunk));
  }

  createTrunk(input: {
    name: string;
    trunk_direction: "inbound";
    trunk_status: "disabled";
    secure: true;
    primary_uri_uuid: string;
  }) {
    this.mutations.push("plivo:create_trunk_disabled");
    const trunkId = "trunk_buildlabs_001";
    this.trunks.push({
      trunk_id: trunkId,
      trunk_domain: "managed.zt.plivo.test",
      ipacl_uuid: null,
      credential_uuid: null,
      fallback_uri_uuid: null,
      ...structuredClone(input),
    });
    return Promise.resolve({ trunkId });
  }

  updateTrunk(
    trunkId: string,
    input: {
      name?: string;
      trunk_status?: "enabled" | "disabled";
      secure?: true;
      primary_uri_uuid?: string;
    },
  ) {
    this.mutations.push(
      input.trunk_status === "enabled"
        ? "plivo:enable_trunk"
        : "plivo:update_trunk_disabled",
    );
    const trunk = this.trunks.find((value) => value.trunk_id === trunkId);
    if (!trunk) throw new Error("Unknown trunk");
    Object.assign(trunk, structuredClone(input));
    return Promise.resolve();
  }

  listAccountNumbers() {
    return Promise.resolve(structuredClone(this.numbers));
  }

  getAccountNumber() {
    this.numberReads += 1;
    const number = this.numbers[0];
    if (!number) throw new Error("Missing target number");
    this.beforeGetNumber?.(this.numberReads, number);
    return Promise.resolve(structuredClone(number));
  }

  assignNumberToTrunk(_phoneNumber: string, trunkId: string) {
    this.mutations.push("plivo:assign_number_last");
    const number = this.numbers[0];
    if (!number) throw new Error("Missing target number");
    number.application = `/v1/Account/${AUTH_ID}/Zentrunk/Trunk/${trunkId}/`;
    return Promise.resolve();
  }
}

class InMemoryElevenLabs implements ElevenLabsSipAdminPort {
  readonly mutations: string[] = [];
  readonly phones: JsonRecord[] = [];
  branch: ElevenLabsBranchFence = {
    agentId: BINDINGS.agentId,
    branchId: BINDINGS.branchId,
    versionId: BINDINGS.versionId,
    currentLivePercentage: 0,
    isMain: false,
  };

  getBranchFence() {
    return Promise.resolve(structuredClone(this.branch));
  }

  listSipPhoneNumbers() {
    return Promise.resolve(structuredClone(this.phones));
  }

  getSipPhoneNumber(phoneNumberId: string) {
    const phone = this.phones.find(
      (value) => value.phoneNumberId === phoneNumberId,
    );
    if (!phone) throw new Error("Unknown phone number");
    return Promise.resolve(structuredClone(phone));
  }

  createSipPhoneNumber(input: {
    phoneNumber: string;
    label: string;
    inboundTrunkConfig: {
      allowedAddresses: [];
      mediaEncryption: "required";
    };
  }) {
    this.mutations.push("elevenlabs:create_phone_unassigned");
    const phoneNumberId = "phnum_buildlabs_plivo_001";
    this.phones.push({
      provider: "sip_trunk",
      phoneNumberId,
      phoneNumber: input.phoneNumber,
      label: input.label,
      inboundTrunk: {
        allowedAddresses: [],
        mediaEncryption: "required",
        hasAuthCredentials: false,
        remoteDomains: [],
        attributesToHeaders: {},
      },
      storeSipMessages: false,
    });
    return Promise.resolve({ phoneNumberId });
  }

  updateSipPhoneNumber(
    phoneNumberId: string,
    input: {
      agentId: string;
      branchId: string;
      environment: "testing";
      label: string;
      inboundTrunkConfig: {
        allowedAddresses: [];
        mediaEncryption: "required";
      };
      storeSipMessages: false;
    },
  ) {
    this.mutations.push("elevenlabs:assign_testing_branch");
    const phone = this.phones.find(
      (value) => value.phoneNumberId === phoneNumberId,
    );
    if (!phone) throw new Error("Unknown phone number");
    Object.assign(phone, {
      label: input.label,
      assignedAgent: {
        agentId: input.agentId,
        agentName: "BuildLabs Voice Intake",
        environment: input.environment,
        branchId: input.branchId,
      },
      inboundTrunk: {
        allowedAddresses: [],
        mediaEncryption: "required",
        hasAuthCredentials: false,
        remoteDomains: [],
        attributesToHeaders: {},
      },
      storeSipMessages: false,
    });
    return Promise.resolve();
  }
}

function fixture() {
  const plivo = new InMemoryPlivo();
  const elevenLabs = new InMemoryElevenLabs();
  return {
    plivo,
    elevenLabs,
    reconciler: new PlivoPstnReconciler(plivo, elevenLabs),
  };
}

describe("Plivo PSTN manifest", () => {
  it("locks inbound TLS/SRTP and every excluded account action", () => {
    expect(
      PlivoPstnManifestSchema.parse(BUILDLABS_PLIVO_PSTN_MANIFEST),
    ).toEqual(BUILDLABS_PLIVO_PSTN_MANIFEST);

    for (const mutate of [
      (value: JsonRecord) => {
        asRecord(asRecord(value.plivo).trunk).secure = false;
      },
      (value: JsonRecord) => {
        asRecord(value.deployment).allowOutboundCalls = true;
      },
      (value: JsonRecord) => {
        asRecord(value.deployment).allowDelete = true;
      },
      (value: JsonRecord) => {
        asRecord(value.elevenLabs).mediaEncryption = "allowed";
      },
    ]) {
      const manifest = structuredClone(
        BUILDLABS_PLIVO_PSTN_MANIFEST,
      ) as unknown as JsonRecord;
      mutate(manifest);
      expect(PlivoPstnManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });
});

describe("Plivo PSTN reconciliation", () => {
  it("defaults to a content-free read-only plan", async () => {
    const { plivo, elevenLabs, reconciler } = fixture();
    const plan = await reconciler.plan(BINDINGS);

    expect(plan).toMatchObject({
      mode: "plan",
      status: "drifted",
      numberRoutingApprovalRequired: true,
      testNumberRoutingMutation: true,
      productionTrafficMutation: false,
      irreversibleAccountMutation: false,
    });
    expect(plan.expectedBaseDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "plivo_origination_uri",
          action: "create",
        }),
        expect.objectContaining({
          resource: "plivo_number_route",
          action: "update",
        }),
      ]),
    );
    expect(plivo.mutations).toEqual([]);
    expect(elevenLabs.mutations).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(BINDINGS.phoneNumber);
    expect(JSON.stringify(plan)).not.toContain(BINDINGS.plivoAuthToken);
  });

  it("rejects stale CAS and missing routing approval before mutation", async () => {
    const first = fixture();
    const plan = await first.reconciler.plan(BINDINGS);
    await expect(
      first.reconciler.apply(BINDINGS, "0".repeat(64), {
        allowNumberRouting: true,
      }),
    ).rejects.toMatchObject({ name: "PlivoPstnCasConflictError" });
    expect(first.plivo.mutations).toEqual([]);
    expect(first.elevenLabs.mutations).toEqual([]);

    await expect(
      first.reconciler.apply(BINDINGS, plan.expectedBaseDigest, {
        allowNumberRouting: false,
      }),
    ).rejects.toMatchObject({ name: "PlivoNumberRoutingApprovalError" });
    expect(first.plivo.mutations).toEqual([]);
    expect(first.elevenLabs.mutations).toEqual([]);
  });

  it("stages secure resources, binds the number last, and converges", async () => {
    const { plivo, elevenLabs, reconciler } = fixture();
    const plan = await reconciler.plan(BINDINGS);
    const result = await reconciler.apply(BINDINGS, plan.expectedBaseDigest, {
      allowNumberRouting: true,
    });

    expect(result).toMatchObject({
      mode: "apply",
      status: "configured",
      appliedChanges: 4,
      testNumberRoutingMutation: true,
      productionTrafficMutation: false,
      irreversibleAccountMutation: false,
    });
    expect(result.readbackDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect([...plivo.mutations, ...elevenLabs.mutations]).toEqual(
      expect.arrayContaining([
        "plivo:create_uri",
        "plivo:create_trunk_disabled",
        "plivo:enable_trunk",
        "plivo:assign_number_last",
        "elevenlabs:create_phone_unassigned",
        "elevenlabs:assign_testing_branch",
      ]),
    );
    expect(plivo.mutations.at(-1)).toBe("plivo:assign_number_last");
    expect(plivo.trunks[0]).toMatchObject({
      trunk_status: "enabled",
      trunk_direction: "inbound",
      secure: true,
      fallback_uri_uuid: null,
      credential_uuid: null,
      ipacl_uuid: null,
    });
    expect(elevenLabs.phones[0]).toMatchObject({
      assignedAgent: {
        agentId: BINDINGS.agentId,
        branchId: BINDINGS.branchId,
        environment: "testing",
      },
      inboundTrunk: { mediaEncryption: "required" },
      storeSipMessages: false,
    });

    const converged = await reconciler.plan(BINDINGS);
    expect(converged.status).toBe("configured");
    const mutationCount = plivo.mutations.length + elevenLabs.mutations.length;
    const replay = await reconciler.apply(
      BINDINGS,
      converged.expectedBaseDigest,
      { allowNumberRouting: false },
    );
    expect(replay.appliedChanges).toBe(0);
    expect(replay.testNumberRoutingMutation).toBe(false);
    expect(plivo.mutations.length + elevenLabs.mutations.length).toBe(
      mutationCount,
    );
  });

  it("refuses unowned provider resources and a pre-mutation route race", async () => {
    const assigned = fixture();
    assigned.plivo.numbers[0]!.application =
      "/v1/Account/authbuildlabs001/Application/unrelated/";
    await expect(assigned.reconciler.plan(BINDINGS)).rejects.toMatchObject({
      name: "PlivoTargetNumberInUseError",
    });

    const collision = fixture();
    collision.plivo.uris.push({
      uri_uuid: "22222222-2222-4222-8222-222222222222",
      name: "Unowned destination",
      uri: "sip.rtc.elevenlabs.io:5061;transport=tls",
      authentication_needed: false,
      username: "",
    });
    await expect(collision.reconciler.plan(BINDINGS)).rejects.toMatchObject({
      name: "PlivoManagedResourceConflictError",
      reason: "unowned_destination_collision",
    });

    const raced = fixture();
    const plan = await raced.reconciler.plan(BINDINGS);
    raced.plivo.beforeGetNumber = (read, number) => {
      if (read === 3) {
        number.application =
          "/v1/Account/authbuildlabs001/Application/concurrent/";
      }
    };
    await expect(
      raced.reconciler.apply(BINDINGS, plan.expectedBaseDigest, {
        allowNumberRouting: true,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(raced.plivo.mutations).toEqual([]);
    expect(raced.elevenLabs.mutations).toEqual([]);
  });

  it("fails closed on stale branch versions, unusable numbers, and outbound SIP configuration", async () => {
    const stale = fixture();
    stale.elevenLabs.branch.versionId = "version_concurrent_change_002";
    await expect(stale.reconciler.plan(BINDINGS)).rejects.toThrow(
      "development branch failed",
    );

    const unavailable = fixture();
    unavailable.plivo.numbers[0]!.voice_enabled = false;
    await expect(unavailable.reconciler.plan(BINDINGS)).rejects.toMatchObject({
      name: "PlivoTargetNumberError",
    });

    const outbound = fixture();
    const initial = await outbound.reconciler.plan(BINDINGS);
    await outbound.reconciler.apply(BINDINGS, initial.expectedBaseDigest, {
      allowNumberRouting: true,
    });
    outbound.elevenLabs.phones[0]!.outboundTrunk = {
      address: "outbound.invalid",
    };
    await expect(outbound.reconciler.plan(BINDINGS)).rejects.toMatchObject({
      name: "PlivoManagedResourceConflictError",
      reason: "outbound_phone_configuration",
    });
  });

  it("refuses in-place repair after the managed public test route is active", async () => {
    const { plivo, reconciler } = fixture();
    const plan = await reconciler.plan(BINDINGS);
    await reconciler.apply(BINDINGS, plan.expectedBaseDigest, {
      allowNumberRouting: true,
    });
    plivo.trunks[0]!.secure = false;

    await expect(reconciler.plan(BINDINGS)).rejects.toMatchObject({
      name: "PlivoActiveRouteDriftError",
    });
  });

  it("rejects an unsafe manifest even when cast around schema validation", async () => {
    const unsafe = structuredClone(
      BUILDLABS_PLIVO_PSTN_MANIFEST,
    ) as unknown as JsonRecord;
    asRecord(unsafe.deployment).allowOutboundCalls = true;
    const { plivo, elevenLabs } = fixture();
    const reconciler = new PlivoPstnReconciler(
      plivo,
      elevenLabs,
      unsafe as unknown as PlivoPstnManifest,
    );
    const plan = await reconciler.plan(BINDINGS);
    await expect(
      reconciler.apply(BINDINGS, plan.expectedBaseDigest, {
        allowNumberRouting: true,
      }),
    ).rejects.toThrow("manifest permits an unsafe action");
    expect(plivo.mutations).toEqual([]);
    expect(elevenLabs.mutations).toEqual([]);
  });
});

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a test object");
  }
  return value as JsonRecord;
}
