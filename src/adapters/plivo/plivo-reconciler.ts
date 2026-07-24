import { createHmac, timingSafeEqual } from "node:crypto";

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { z } from "zod";

import { digestJson } from "../../lib/canonical-json.js";
import {
  BUILDLABS_PLIVO_PSTN_MANIFEST,
  type PlivoPstnManifest,
} from "./plivo-manifest.js";

type JsonRecord = Record<string, unknown>;

const E164 = /^\+[1-9][0-9]{7,14}$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,199}$/u;
const AGENT_ID = /^agent_[A-Za-z0-9_-]{8,180}$/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const MANAGED_TAG = /^[a-f0-9]{12}$/u;

const PlivoUriSchema = z
  .object({
    uri_uuid: z.string().uuid(),
    name: z.string().min(1).max(255),
    uri: z.string().min(1).max(500),
    authentication_needed: z.boolean(),
    username: z.string().nullable().optional(),
  })
  .passthrough();

const PlivoTrunkSchema = z
  .object({
    trunk_id: z.string().min(1).max(80),
    trunk_domain: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    trunk_status: z.enum(["enabled", "disabled"]),
    secure: z.boolean(),
    trunk_direction: z.enum(["inbound", "outbound"]),
    ipacl_uuid: z.string().nullable(),
    credential_uuid: z.string().nullable(),
    primary_uri_uuid: z.string().nullable(),
    fallback_uri_uuid: z.string().nullable(),
  })
  .passthrough();

const PlivoNumberSchema = z
  .object({
    number: z.string().min(8).max(16),
    active: z.boolean(),
    voice_enabled: z.boolean(),
    application: z.string().nullable(),
  })
  .passthrough();

const AssignedAgentSchema = z
  .object({
    agentId: z.string(),
    agentName: z.string(),
    environment: z.string().optional(),
    branchId: z.string().optional(),
  })
  .passthrough();

const ElevenSipPhoneSchema = z
  .object({
    provider: z.literal("sip_trunk"),
    phoneNumberId: z.string().min(8).max(200),
    phoneNumber: z.string().min(8).max(32),
    label: z.string().min(1).max(255),
    assignedAgent: AssignedAgentSchema.optional(),
    inboundTrunk: z.record(z.string(), z.unknown()).optional(),
    outboundTrunk: z.record(z.string(), z.unknown()).optional(),
    providerConfig: z.record(z.string(), z.unknown()).optional(),
    storeSipMessages: z.boolean().optional(),
  })
  .passthrough();

export const PlivoPstnBindingsSchema = z
  .object({
    plivoAuthId: z
      .string()
      .min(8)
      .max(80)
      .regex(/^[A-Za-z0-9]+$/u),
    plivoAuthToken: z.string().min(20).max(500),
    reconciliationSecret: z.string().min(32).max(500),
    phoneNumber: z.string().regex(E164),
    elevenLabsApiKey: z.string().min(20).max(500),
    agentId: z.string().regex(AGENT_ID),
    branchId: z.string().regex(RESOURCE_ID),
    versionId: z.string().regex(RESOURCE_ID),
  })
  .strict();

export type PlivoPstnBindings = z.infer<typeof PlivoPstnBindingsSchema>;

export type ElevenLabsBranchFence = {
  agentId: string;
  branchId: string;
  versionId: string;
  currentLivePercentage: number;
  isMain: boolean;
};

export interface PlivoPstnAdminPort {
  listOriginationUris(): Promise<unknown[]>;
  getOriginationUri(uriId: string): Promise<unknown>;
  createOriginationUri(input: {
    name: string;
    uri: string;
    authentication_needed: false;
  }): Promise<{ uriId: string }>;
  updateOriginationUri(
    uriId: string,
    input: {
      name: string;
      uri: string;
      authentication_needed: false;
    },
  ): Promise<void>;
  listTrunks(): Promise<unknown[]>;
  getTrunk(trunkId: string): Promise<unknown>;
  createTrunk(input: {
    name: string;
    trunk_direction: "inbound";
    trunk_status: "disabled";
    secure: true;
    primary_uri_uuid: string;
  }): Promise<{ trunkId: string }>;
  updateTrunk(
    trunkId: string,
    input: {
      name?: string;
      trunk_status?: "enabled" | "disabled";
      secure?: true;
      primary_uri_uuid?: string;
    },
  ): Promise<void>;
  listAccountNumbers(): Promise<unknown[]>;
  getAccountNumber(phoneNumber: string): Promise<unknown>;
  assignNumberToTrunk(phoneNumber: string, trunkId: string): Promise<void>;
}

export interface ElevenLabsSipAdminPort {
  getBranchFence(
    agentId: string,
    branchId: string,
  ): Promise<ElevenLabsBranchFence>;
  listSipPhoneNumbers(): Promise<unknown[]>;
  getSipPhoneNumber(phoneNumberId: string): Promise<unknown>;
  createSipPhoneNumber(input: {
    phoneNumber: string;
    label: string;
    inboundTrunkConfig: {
      allowedAddresses: [];
      mediaEncryption: "required";
    };
  }): Promise<{ phoneNumberId: string }>;
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
  ): Promise<void>;
}

export type PlivoPstnChange = {
  resource:
    | "elevenlabs_sip_number"
    | "plivo_inbound_trunk"
    | "plivo_number_route"
    | "plivo_origination_uri";
  action: "create" | "none" | "update";
  currentDigest?: string;
  desiredDigest: string;
};

export type PlivoPstnPlan = {
  mode: "plan";
  status: "configured" | "drifted";
  expectedBaseDigest: string;
  manifestDigest: string;
  changes: PlivoPstnChange[];
  numberRoutingApprovalRequired: boolean;
  testNumberRoutingMutation: boolean;
  productionTrafficMutation: false;
  irreversibleAccountMutation: false;
};

export type PlivoPstnApplyResult = {
  mode: "apply";
  status: "configured";
  manifestDigest: string;
  appliedChanges: number;
  readbackDigest: string;
  plivoUriId: string;
  plivoTrunkId: string;
  elevenLabsPhoneNumberId: string;
  testNumberRoutingMutation: boolean;
  productionTrafficMutation: false;
  irreversibleAccountMutation: false;
};

type ManagedNames = {
  tag: string;
  uri: string;
  trunk: string;
  phone: string;
};

type RemoteState = {
  names: ManagedNames;
  uris: z.infer<typeof PlivoUriSchema>[];
  trunks: z.infer<typeof PlivoTrunkSchema>[];
  numbers: z.infer<typeof PlivoNumberSchema>[];
  targetNumber: z.infer<typeof PlivoNumberSchema>;
  phones: z.infer<typeof ElevenSipPhoneSchema>[];
  branch: ElevenLabsBranchFence;
  managedUri?: z.infer<typeof PlivoUriSchema>;
  managedTrunk?: z.infer<typeof PlivoTrunkSchema>;
  managedPhone?: z.infer<typeof ElevenSipPhoneSchema>;
};

export class PlivoPstnReconciler {
  readonly #plivo: PlivoPstnAdminPort;
  readonly #elevenLabs: ElevenLabsSipAdminPort;
  readonly #manifest: PlivoPstnManifest;

  constructor(
    plivo: PlivoPstnAdminPort,
    elevenLabs: ElevenLabsSipAdminPort,
    manifest: PlivoPstnManifest = BUILDLABS_PLIVO_PSTN_MANIFEST,
  ) {
    this.#plivo = plivo;
    this.#elevenLabs = elevenLabs;
    this.#manifest = manifest;
  }

  async plan(unsafeBindings: PlivoPstnBindings): Promise<PlivoPstnPlan> {
    const bindings = PlivoPstnBindingsSchema.parse(unsafeBindings);
    const state = await this.#readState(bindings);
    return this.#planFromState(bindings, state);
  }

  async apply(
    unsafeBindings: PlivoPstnBindings,
    expectedBaseDigest: string,
    options: { allowNumberRouting: boolean },
  ): Promise<PlivoPstnApplyResult> {
    const bindings = PlivoPstnBindingsSchema.parse(unsafeBindings);
    if (!HEX_DIGEST.test(expectedBaseDigest)) {
      throw new Error("The expected Plivo base digest is invalid");
    }
    this.#assertSafeManifest();

    const initial = await this.#readState(bindings);
    const initialPlan = this.#planFromState(bindings, initial);
    assertDigestEqual(
      expectedBaseDigest,
      initialPlan.expectedBaseDigest,
      "Plivo expected-base-digest conflict",
    );
    if (
      initialPlan.numberRoutingApprovalRequired &&
      !options.allowNumberRouting
    ) {
      throw new PlivoNumberRoutingApprovalError();
    }
    if (initialPlan.status === "configured") {
      return this.#resultFromState(bindings, initial, 0, false);
    }

    const preMutation = await this.#readState(bindings);
    const preMutationPlan = this.#planFromState(bindings, preMutation);
    assertDigestEqual(
      expectedBaseDigest,
      preMutationPlan.expectedBaseDigest,
      "Plivo expected-base-digest conflict",
    );

    const initialRoute = preMutation.targetNumber.application;
    const initialBranchVersion = preMutation.branch.versionId;
    let uri = preMutation.managedUri;
    if (!uri) {
      const created = await this.#plivo.createOriginationUri(
        desiredUri(this.#manifest, preMutation.names),
      );
      uri = PlivoUriSchema.parse(
        await this.#plivo.getOriginationUri(created.uriId),
      );
    } else if (
      keyedDigest(bindings.reconciliationSecret, uriProjection(uri)) !==
      keyedDigest(
        bindings.reconciliationSecret,
        desiredUri(this.#manifest, preMutation.names),
      )
    ) {
      await this.#plivo.updateOriginationUri(
        uri.uri_uuid,
        desiredUri(this.#manifest, preMutation.names),
      );
      uri = PlivoUriSchema.parse(
        await this.#plivo.getOriginationUri(uri.uri_uuid),
      );
    }
    assertProjectionEqual(
      uriProjection(uri),
      desiredUri(this.#manifest, preMutation.names),
      "Plivo origination URI readback drifted",
    );

    let trunk = preMutation.managedTrunk;
    if (!trunk) {
      const created = await this.#plivo.createTrunk({
        name: preMutation.names.trunk,
        trunk_direction: "inbound",
        trunk_status: "disabled",
        secure: true,
        primary_uri_uuid: uri.uri_uuid,
      });
      trunk = PlivoTrunkSchema.parse(
        await this.#plivo.getTrunk(created.trunkId),
      );
    } else if (!stagedTrunkMatches(trunk, preMutation.names, uri.uri_uuid)) {
      await this.#plivo.updateTrunk(trunk.trunk_id, {
        name: preMutation.names.trunk,
        trunk_status: "disabled",
        secure: true,
        primary_uri_uuid: uri.uri_uuid,
      });
      trunk = PlivoTrunkSchema.parse(
        await this.#plivo.getTrunk(trunk.trunk_id),
      );
    }
    if (!stagedTrunkMatches(trunk, preMutation.names, uri.uri_uuid)) {
      throw new Error("Plivo staged trunk readback drifted");
    }

    let phone = preMutation.managedPhone;
    if (!phone) {
      const created = await this.#elevenLabs.createSipPhoneNumber({
        phoneNumber: bindings.phoneNumber,
        label: preMutation.names.phone,
        inboundTrunkConfig: {
          allowedAddresses: [],
          mediaEncryption: "required",
        },
      });
      phone = ElevenSipPhoneSchema.parse(
        await this.#elevenLabs.getSipPhoneNumber(created.phoneNumberId),
      );
    }
    if (!phoneMatchesDesired(phone, bindings, preMutation.names)) {
      await this.#elevenLabs.updateSipPhoneNumber(phone.phoneNumberId, {
        agentId: bindings.agentId,
        branchId: bindings.branchId,
        environment: "testing",
        label: preMutation.names.phone,
        inboundTrunkConfig: {
          allowedAddresses: [],
          mediaEncryption: "required",
        },
        storeSipMessages: false,
      });
      phone = ElevenSipPhoneSchema.parse(
        await this.#elevenLabs.getSipPhoneNumber(phone.phoneNumberId),
      );
    }
    if (!phoneMatchesDesired(phone, bindings, preMutation.names)) {
      throw new Error("ElevenLabs SIP number readback drifted");
    }

    const branchBeforeRoute = await this.#elevenLabs.getBranchFence(
      bindings.agentId,
      bindings.branchId,
    );
    assertBranchFence(branchBeforeRoute, bindings);
    assertDigestEqual(
      keyedDigest(bindings.reconciliationSecret, {
        application: initialRoute,
        branchVersion: initialBranchVersion,
      }),
      keyedDigest(bindings.reconciliationSecret, {
        application: PlivoNumberSchema.parse(
          await this.#plivo.getAccountNumber(bindings.phoneNumber),
        ).application,
        branchVersion: branchBeforeRoute.versionId,
      }),
      "Plivo route precondition conflict",
    );

    if (!trunkMatchesDesired(trunk, preMutation.names, uri.uri_uuid)) {
      await this.#plivo.updateTrunk(trunk.trunk_id, {
        trunk_status: "enabled",
      });
      trunk = PlivoTrunkSchema.parse(
        await this.#plivo.getTrunk(trunk.trunk_id),
      );
    }
    if (!trunkMatchesDesired(trunk, preMutation.names, uri.uri_uuid)) {
      throw new Error("Plivo enabled trunk readback drifted");
    }

    const routeBeforeWrite = PlivoNumberSchema.parse(
      await this.#plivo.getAccountNumber(bindings.phoneNumber),
    );
    const desiredApplication = trunkApplicationResource(
      bindings.plivoAuthId,
      trunk.trunk_id,
    );
    let routeChanged = false;
    if (routeBeforeWrite.application !== desiredApplication) {
      assertDigestEqual(
        keyedDigest(bindings.reconciliationSecret, initialRoute),
        keyedDigest(
          bindings.reconciliationSecret,
          routeBeforeWrite.application,
        ),
        "Plivo number assignment changed before final routing",
      );
      await this.#plivo.assignNumberToTrunk(
        bindings.phoneNumber,
        trunk.trunk_id,
      );
      routeChanged = true;
    }
    const routeReadback = PlivoNumberSchema.parse(
      await this.#plivo.getAccountNumber(bindings.phoneNumber),
    );
    if (routeReadback.application !== desiredApplication) {
      throw new Error("Plivo test-number route failed readback validation");
    }

    const finalState = await this.#readState(bindings);
    const finalPlan = this.#planFromState(bindings, finalState);
    if (finalPlan.status !== "configured") {
      throw new Error(
        `Plivo managed readback drifted for ${finalPlan.changes
          .filter((change) => change.action !== "none")
          .map((change) => change.resource)
          .join(",")}`,
      );
    }
    return this.#resultFromState(
      bindings,
      finalState,
      initialPlan.changes.filter((change) => change.action !== "none").length,
      routeChanged,
    );
  }

  #assertSafeManifest() {
    const manifest = this.#manifest;
    if (
      manifest.provider.direction !== "inbound_only" ||
      manifest.plivo.originationUri.destination !==
        "sip.rtc.elevenlabs.io:5061;transport=tls" ||
      manifest.plivo.originationUri.authenticationNeeded ||
      !manifest.plivo.trunk.secure ||
      manifest.plivo.trunk.direction !== "inbound" ||
      manifest.plivo.trunk.fallbackUriAllowed ||
      manifest.plivo.trunk.credentialAllowed ||
      manifest.plivo.trunk.ipAclAllowed ||
      manifest.elevenLabs.environment !== "testing" ||
      manifest.elevenLabs.mediaEncryption !== "required" ||
      manifest.elevenLabs.storeSipMessages ||
      manifest.elevenLabs.outboundTrunkAllowed ||
      manifest.deployment.allowProductionTraffic ||
      manifest.deployment.allowOutboundCalls ||
      manifest.deployment.allowNumberPurchase ||
      manifest.deployment.allowNumberRelease ||
      manifest.deployment.allowDelete ||
      manifest.deployment.plivoRecordingEnabled ||
      manifest.deployment.plivoTranscriptionEnabled ||
      manifest.reconciliation.blindMutationRetries !== 0
    ) {
      throw new Error("The repository Plivo manifest permits an unsafe action");
    }
  }

  async #readState(bindings: PlivoPstnBindings): Promise<RemoteState> {
    const names = managedNames(this.#manifest, bindings);
    const branch = await this.#elevenLabs.getBranchFence(
      bindings.agentId,
      bindings.branchId,
    );
    assertBranchFence(branch, bindings);

    const uris = z
      .array(PlivoUriSchema)
      .parse(await this.#plivo.listOriginationUris());
    const trunks = z
      .array(PlivoTrunkSchema)
      .parse(await this.#plivo.listTrunks());
    const numbers = z
      .array(PlivoNumberSchema)
      .parse(await this.#plivo.listAccountNumbers());
    const targetNumber = PlivoNumberSchema.parse(
      await this.#plivo.getAccountNumber(bindings.phoneNumber),
    );
    const phones = z
      .array(ElevenSipPhoneSchema)
      .parse(await this.#elevenLabs.listSipPhoneNumbers());

    if (
      normalizedDigits(targetNumber.number) !==
        normalizedDigits(bindings.phoneNumber) ||
      !targetNumber.active ||
      !targetNumber.voice_enabled
    ) {
      throw new PlivoTargetNumberError();
    }

    const uriMatches = uris.filter((uri) => uri.name === names.uri);
    const trunkMatches = trunks.filter((trunk) => trunk.name === names.trunk);
    const phoneMatches = phones.filter((phone) => phone.label === names.phone);
    if (
      uriMatches.length > 1 ||
      trunkMatches.length > 1 ||
      phoneMatches.length > 1
    ) {
      throw new PlivoManagedResourceConflictError("duplicate_managed_resource");
    }
    const managedUri = uriMatches[0];
    const managedTrunk = trunkMatches[0];
    const managedPhone = phoneMatches[0];

    const destinationCollision = uris.some(
      (uri) =>
        uri.uri === this.#manifest.plivo.originationUri.destination &&
        uri.name !== names.uri,
    );
    if (destinationCollision) {
      throw new PlivoManagedResourceConflictError(
        "unowned_destination_collision",
      );
    }
    if (
      managedUri &&
      trunks.some(
        (trunk) =>
          trunk.trunk_id !== managedTrunk?.trunk_id &&
          (trunk.primary_uri_uuid === managedUri.uri_uuid ||
            trunk.fallback_uri_uuid === managedUri.uri_uuid),
      )
    ) {
      throw new PlivoManagedResourceConflictError("shared_uri_dependency");
    }
    if (
      managedTrunk &&
      numbers.some(
        (number) =>
          normalizedDigits(number.number) !==
            normalizedDigits(bindings.phoneNumber) &&
          number.application ===
            trunkApplicationResource(
              bindings.plivoAuthId,
              managedTrunk.trunk_id,
            ),
      )
    ) {
      throw new PlivoManagedResourceConflictError("shared_trunk_dependency");
    }

    const targetPhones = phones.filter(
      (phone) =>
        normalizedDigits(phone.phoneNumber) ===
        normalizedDigits(bindings.phoneNumber),
    );
    if (
      targetPhones.length > 1 ||
      (targetPhones[0] && targetPhones[0].label !== names.phone) ||
      (managedPhone &&
        normalizedDigits(managedPhone.phoneNumber) !==
          normalizedDigits(bindings.phoneNumber))
    ) {
      throw new PlivoManagedResourceConflictError(
        "unowned_elevenlabs_phone_collision",
      );
    }
    const resolvedPhone = managedPhone ?? targetPhones[0];
    if (
      resolvedPhone &&
      (hasKeys(resolvedPhone.outboundTrunk) ||
        hasKeys(resolvedPhone.providerConfig))
    ) {
      throw new PlivoManagedResourceConflictError(
        "outbound_phone_configuration",
      );
    }

    const currentApplication = targetNumber.application;
    if (
      currentApplication !== null &&
      (!managedTrunk ||
        currentApplication !==
          trunkApplicationResource(bindings.plivoAuthId, managedTrunk.trunk_id))
    ) {
      throw new PlivoTargetNumberInUseError();
    }

    const state: RemoteState = {
      names,
      uris,
      trunks,
      numbers,
      targetNumber,
      phones,
      branch,
      ...(managedUri ? { managedUri } : {}),
      ...(managedTrunk ? { managedTrunk } : {}),
      ...(resolvedPhone ? { managedPhone: resolvedPhone } : {}),
    };
    const activeManagedRoute =
      managedTrunk &&
      targetNumber.application ===
        trunkApplicationResource(bindings.plivoAuthId, managedTrunk.trunk_id);
    if (activeManagedRoute) {
      const changes = buildChanges(this.#manifest, bindings, state);
      if (changes.some((change) => change.action !== "none")) {
        throw new PlivoActiveRouteDriftError();
      }
    }
    return state;
  }

  #planFromState(
    bindings: PlivoPstnBindings,
    state: RemoteState,
  ): PlivoPstnPlan {
    const changes = buildChanges(this.#manifest, bindings, state);
    const routeSensitive = changes.some(
      (change) =>
        change.action !== "none" &&
        (change.resource === "elevenlabs_sip_number" ||
          change.resource === "plivo_number_route"),
    );
    return {
      mode: "plan",
      status: changes.every((change) => change.action === "none")
        ? "configured"
        : "drifted",
      expectedBaseDigest: stateDigest(this.#manifest, bindings, state),
      manifestDigest: digestJson(this.#manifest),
      changes,
      numberRoutingApprovalRequired: routeSensitive,
      testNumberRoutingMutation: routeSensitive,
      productionTrafficMutation: false,
      irreversibleAccountMutation: false,
    };
  }

  #resultFromState(
    bindings: PlivoPstnBindings,
    state: RemoteState,
    appliedChanges: number,
    routeChanged: boolean,
  ): PlivoPstnApplyResult {
    if (!state.managedUri || !state.managedTrunk || !state.managedPhone) {
      throw new Error("Plivo reconciliation result is incomplete");
    }
    return {
      mode: "apply",
      status: "configured",
      manifestDigest: digestJson(this.#manifest),
      appliedChanges,
      readbackDigest: stateDigest(this.#manifest, bindings, state),
      plivoUriId: state.managedUri.uri_uuid,
      plivoTrunkId: state.managedTrunk.trunk_id,
      elevenLabsPhoneNumberId: state.managedPhone.phoneNumberId,
      testNumberRoutingMutation: routeChanged,
      productionTrafficMutation: false,
      irreversibleAccountMutation: false,
    };
  }
}

export class PlivoRestPstnAdmin implements PlivoPstnAdminPort {
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #manifest: PlivoPstnManifest;

  constructor(
    authId: string,
    authToken: string,
    manifest: PlivoPstnManifest = BUILDLABS_PLIVO_PSTN_MANIFEST,
  ) {
    if (!/^[A-Za-z0-9]{8,80}$/u.test(authId) || authToken.length < 20) {
      throw new Error("Configured Plivo credentials are required");
    }
    this.#baseUrl = `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}`;
    this.#authorization = `Basic ${Buffer.from(
      `${authId}:${authToken}`,
    ).toString("base64")}`;
    this.#manifest = manifest;
  }

  listOriginationUris() {
    return this.#list("/Zentrunk/URI/");
  }

  async getOriginationUri(uriId: string) {
    return this.#request(`/Zentrunk/URI/${encodeURIComponent(uriId)}/`, "GET");
  }

  async createOriginationUri(input: {
    name: string;
    uri: string;
    authentication_needed: false;
  }) {
    const response = await this.#request("/Zentrunk/URI/", "POST", input);
    return { uriId: z.string().uuid().parse(response.uri_uuid) };
  }

  async updateOriginationUri(
    uriId: string,
    input: {
      name: string;
      uri: string;
      authentication_needed: false;
    },
  ) {
    await this.#request(
      `/Zentrunk/URI/${encodeURIComponent(uriId)}/`,
      "POST",
      input,
    );
  }

  listTrunks() {
    return this.#list("/Zentrunk/Trunk/");
  }

  async getTrunk(trunkId: string) {
    const response = await this.#request(
      `/Zentrunk/Trunk/${encodeURIComponent(trunkId)}/`,
      "GET",
    );
    return response.object ?? response;
  }

  async createTrunk(input: {
    name: string;
    trunk_direction: "inbound";
    trunk_status: "disabled";
    secure: true;
    primary_uri_uuid: string;
  }) {
    const response = await this.#request("/Zentrunk/Trunk/", "POST", input);
    return { trunkId: z.string().min(1).parse(response.trunk_id) };
  }

  async updateTrunk(
    trunkId: string,
    input: {
      name?: string;
      trunk_status?: "enabled" | "disabled";
      secure?: true;
      primary_uri_uuid?: string;
    },
  ) {
    await this.#request(
      `/Zentrunk/Trunk/${encodeURIComponent(trunkId)}/`,
      "POST",
      input,
    );
  }

  listAccountNumbers() {
    return this.#list("/Number/");
  }

  getAccountNumber(phoneNumber: string) {
    return this.#request(
      `/Number/${encodeURIComponent(normalizedDigits(phoneNumber))}/`,
      "GET",
    );
  }

  async assignNumberToTrunk(phoneNumber: string, trunkId: string) {
    await this.#request(
      `/Number/${encodeURIComponent(normalizedDigits(phoneNumber))}/`,
      "POST",
      { app_id: trunkId },
    );
  }

  async #list(path: string): Promise<unknown[]> {
    const results: unknown[] = [];
    const seenOffsets = new Set<number>();
    const pageSize = this.#manifest.reconciliation.pageSize;
    for (
      let page = 0;
      page < this.#manifest.reconciliation.maximumPages;
      page += 1
    ) {
      const offset = page * pageSize;
      if (seenOffsets.has(offset)) {
        throw new Error("Plivo pagination repeated an offset");
      }
      seenOffsets.add(offset);
      const response = await this.#request(
        `${path}?limit=${pageSize}&offset=${offset}`,
        "GET",
      );
      const objects = z.array(z.unknown()).parse(response.objects);
      const meta = z
        .object({
          limit: z.number().int().positive(),
          offset: z.number().int().nonnegative(),
          total_count: z.number().int().nonnegative(),
          next: z.string().nullable().optional(),
        })
        .passthrough()
        .parse(response.meta);
      if (meta.offset !== offset || objects.length > pageSize) {
        throw new Error("Plivo returned malformed pagination metadata");
      }
      results.push(...objects);
      if (results.length >= meta.total_count) {
        if (results.length !== meta.total_count) {
          throw new Error("Plivo returned an inconsistent result count");
        }
        return results;
      }
      if (!meta.next || objects.length === 0) {
        throw new Error("Plivo returned an incomplete resource listing");
      }
    }
    throw new Error("Plivo pagination exceeded its configured bound");
  }

  async #request(
    path: string,
    method: "GET" | "POST",
    body?: JsonRecord,
  ): Promise<JsonRecord> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: this.#authorization,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(
        this.#manifest.reconciliation.requestTimeoutMs,
      ),
    });
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > 2_000_000) {
      throw new Error("Plivo returned an oversized response");
    }
    let parsed: unknown;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      throw new Error("Plivo returned malformed JSON");
    }
    if (
      !response.ok ||
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(`Plivo request failed with status ${response.status}`);
    }
    return parsed as JsonRecord;
  }
}

export class ElevenLabsSdkSipAdmin implements ElevenLabsSipAdminPort {
  readonly #client: ElevenLabsClient;

  constructor(apiKey: string) {
    if (apiKey.trim().length < 20) {
      throw new Error("A configured ElevenLabs API key is required");
    }
    this.#client = new ElevenLabsClient({
      apiKey,
      timeoutInSeconds: 20,
    });
  }

  async getBranchFence(
    agentId: string,
    branchId: string,
  ): Promise<ElevenLabsBranchFence> {
    const branch = record(
      await this.#client.conversationalAi.agents.branches.get(
        agentId,
        branchId,
      ),
    );
    const agent = record(
      await this.#client.conversationalAi.agents.get(agentId, { branchId }),
    );
    const versions = z
      .array(z.unknown())
      .parse(
        Array.isArray(branch.mostRecentVersions)
          ? branch.mostRecentVersions
          : Array.isArray(branch.most_recent_versions)
            ? branch.most_recent_versions
            : [],
      );
    const latest = [...versions]
      .map(record)
      .sort(
        (left, right) =>
          Number(right.seqNoInBranch ?? right.seq_no_in_branch ?? 0) -
          Number(left.seqNoInBranch ?? left.seq_no_in_branch ?? 0),
      )[0];
    const versionId = firstString(
      agent.versionId,
      agent.version_id,
      latest?.id,
    );
    return {
      agentId,
      branchId: firstString(branch.id, branch.branch_id, branchId),
      versionId,
      currentLivePercentage: Number(
        branch.currentLivePercentage ?? branch.current_live_percentage ?? 0,
      ),
      isMain:
        firstString(agent.mainBranchId, agent.main_branch_id) === branchId,
    };
  }

  async listSipPhoneNumbers() {
    return this.#client.conversationalAi.phoneNumbers.list({
      provider: "sip_trunk",
    });
  }

  getSipPhoneNumber(phoneNumberId: string) {
    return this.#client.conversationalAi.phoneNumbers.get(phoneNumberId);
  }

  async createSipPhoneNumber(input: {
    phoneNumber: string;
    label: string;
    inboundTrunkConfig: {
      allowedAddresses: [];
      mediaEncryption: "required";
    };
  }) {
    return this.#client.conversationalAi.phoneNumbers.create({
      provider: "sip_trunk",
      ...input,
    });
  }

  async updateSipPhoneNumber(
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
    await this.#client.conversationalAi.phoneNumbers.update(
      phoneNumberId,
      input,
    );
  }
}

export class PlivoPstnCasConflictError extends Error {
  constructor() {
    super("Plivo expected-base-digest conflict");
    this.name = "PlivoPstnCasConflictError";
  }
}

export class PlivoNumberRoutingApprovalError extends Error {
  constructor() {
    super("Explicit test-number routing approval is required");
    this.name = "PlivoNumberRoutingApprovalError";
  }
}

export class PlivoManagedResourceConflictError extends Error {
  constructor(readonly reason: string) {
    super("A Plivo or ElevenLabs resource ownership conflict was detected");
    this.name = "PlivoManagedResourceConflictError";
  }
}

export class PlivoTargetNumberInUseError extends Error {
  constructor() {
    super("The configured Plivo test number is already assigned");
    this.name = "PlivoTargetNumberInUseError";
  }
}

export class PlivoTargetNumberError extends Error {
  constructor() {
    super("The configured Plivo test number is unavailable for voice routing");
    this.name = "PlivoTargetNumberError";
  }
}

export class PlivoActiveRouteDriftError extends Error {
  constructor() {
    super("Refusing to repair drift on an active managed Plivo route");
    this.name = "PlivoActiveRouteDriftError";
  }
}

export function plivoBindingsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PlivoPstnBindings {
  const manifest = BUILDLABS_PLIVO_PSTN_MANIFEST;
  return PlivoPstnBindingsSchema.parse({
    plivoAuthId: environment[manifest.plivo.authIdEnvironmentVariable],
    plivoAuthToken: environment[manifest.plivo.authTokenEnvironmentVariable],
    reconciliationSecret:
      environment[manifest.plivo.reconciliationSecretEnvironmentVariable],
    phoneNumber: environment[manifest.plivo.numberEnvironmentVariable],
    elevenLabsApiKey:
      environment[manifest.elevenLabs.apiKeyEnvironmentVariable],
    agentId: environment[manifest.elevenLabs.agentIdEnvironmentVariable],
    branchId: environment[manifest.elevenLabs.branchIdEnvironmentVariable],
    versionId: environment[manifest.elevenLabs.versionIdEnvironmentVariable],
  });
}

function buildChanges(
  manifest: PlivoPstnManifest,
  bindings: PlivoPstnBindings,
  state: RemoteState,
): PlivoPstnChange[] {
  const desiredUriValue = desiredUri(manifest, state.names);
  const currentUriValue = state.managedUri
    ? uriProjection(state.managedUri)
    : undefined;
  const desiredTrunkValue = {
    name: state.names.trunk,
    trunk_status: "enabled",
    secure: true,
    trunk_direction: "inbound",
    ipacl_uuid: null,
    credential_uuid: null,
    primary_uri_uuid: state.managedUri?.uri_uuid ?? "pending",
    fallback_uri_uuid: null,
  };
  const currentTrunkValue = state.managedTrunk
    ? trunkProjection(state.managedTrunk)
    : undefined;
  const desiredPhoneValue = desiredPhoneProjection(bindings, state.names);
  const currentPhoneValue = state.managedPhone
    ? phoneProjection(state.managedPhone)
    : undefined;
  const desiredRouteValue = {
    application: state.managedTrunk
      ? trunkApplicationResource(
          bindings.plivoAuthId,
          state.managedTrunk.trunk_id,
        )
      : "pending",
  };
  const currentRouteValue = {
    application: state.targetNumber.application,
  };
  const entries: Array<{
    resource: PlivoPstnChange["resource"];
    current?: unknown;
    desired: unknown;
    missingAction: "create" | "update";
  }> = [
    {
      resource: "plivo_origination_uri",
      current: currentUriValue,
      desired: desiredUriValue,
      missingAction: "create",
    },
    {
      resource: "plivo_inbound_trunk",
      current: currentTrunkValue,
      desired: desiredTrunkValue,
      missingAction: "create",
    },
    {
      resource: "elevenlabs_sip_number",
      current: currentPhoneValue,
      desired: desiredPhoneValue,
      missingAction: "create",
    },
    {
      resource: "plivo_number_route",
      current: currentRouteValue,
      desired: desiredRouteValue,
      missingAction: "update",
    },
  ];
  return entries.map((entry) => {
    const currentDigest =
      entry.current === undefined
        ? undefined
        : keyedDigest(bindings.reconciliationSecret, entry.current);
    const desiredDigest = keyedDigest(
      bindings.reconciliationSecret,
      entry.desired,
    );
    return {
      resource: entry.resource,
      action:
        entry.current === undefined
          ? entry.missingAction
          : currentDigest === desiredDigest
            ? "none"
            : "update",
      ...(currentDigest ? { currentDigest } : {}),
      desiredDigest,
    };
  });
}

function stateDigest(
  manifest: PlivoPstnManifest,
  bindings: PlivoPstnBindings,
  state: RemoteState,
) {
  return keyedDigest(bindings.reconciliationSecret, {
    manifestDigest: digestJson(manifest),
    targetNumber: {
      number: bindings.phoneNumber,
      active: state.targetNumber.active,
      voiceEnabled: state.targetNumber.voice_enabled,
      application: state.targetNumber.application,
    },
    managedUri: state.managedUri ? uriProjection(state.managedUri) : null,
    managedTrunk: state.managedTrunk
      ? trunkProjection(state.managedTrunk)
      : null,
    managedPhone: state.managedPhone
      ? phoneProjection(state.managedPhone)
      : null,
    branch: state.branch,
    dependencyIds: {
      uri: state.managedUri
        ? state.trunks
            .filter(
              (trunk) =>
                trunk.primary_uri_uuid === state.managedUri?.uri_uuid ||
                trunk.fallback_uri_uuid === state.managedUri?.uri_uuid,
            )
            .map((trunk) => trunk.trunk_id)
            .sort()
        : [],
      trunk: state.managedTrunk
        ? state.numbers
            .filter(
              (number) =>
                number.application ===
                trunkApplicationResource(
                  bindings.plivoAuthId,
                  state.managedTrunk!.trunk_id,
                ),
            )
            .map((number) => normalizedDigits(number.number))
            .sort()
        : [],
    },
    counts: {
      uris: state.uris.length,
      trunks: state.trunks.length,
      numbers: state.numbers.length,
      phones: state.phones.length,
    },
  });
}

function managedNames(
  manifest: PlivoPstnManifest,
  bindings: PlivoPstnBindings,
): ManagedNames {
  const tag = keyedDigest(bindings.reconciliationSecret, {
    schemaVersion: manifest.schemaVersion,
    account: bindings.plivoAuthId,
    owner: "buildlabs-plivo-pstn",
  }).slice(0, 12);
  if (!MANAGED_TAG.test(tag)) throw new Error("Invalid managed resource tag");
  return {
    tag,
    uri: `${manifest.plivo.originationUri.namePrefix} ${tag} URI`,
    trunk: `${manifest.plivo.trunk.namePrefix} ${tag} inbound`,
    phone: `${manifest.elevenLabs.phoneLabelPrefix} ${tag} Plivo intake`,
  };
}

function desiredUri(manifest: PlivoPstnManifest, names: ManagedNames) {
  return {
    name: names.uri,
    uri: manifest.plivo.originationUri.destination,
    authentication_needed: false as const,
  };
}

function uriProjection(uri: z.infer<typeof PlivoUriSchema>) {
  return {
    name: uri.name,
    uri: uri.uri,
    authentication_needed: uri.authentication_needed,
  };
}

function trunkProjection(trunk: z.infer<typeof PlivoTrunkSchema>) {
  return {
    name: trunk.name,
    trunk_status: trunk.trunk_status,
    secure: trunk.secure,
    trunk_direction: trunk.trunk_direction,
    ipacl_uuid: trunk.ipacl_uuid,
    credential_uuid: trunk.credential_uuid,
    primary_uri_uuid: trunk.primary_uri_uuid,
    fallback_uri_uuid: trunk.fallback_uri_uuid,
  };
}

function stagedTrunkMatches(
  trunk: z.infer<typeof PlivoTrunkSchema>,
  names: ManagedNames,
  uriId: string,
) {
  return (
    trunk.name === names.trunk &&
    trunk.trunk_status === "disabled" &&
    trunk.secure &&
    trunk.trunk_direction === "inbound" &&
    trunk.ipacl_uuid === null &&
    trunk.credential_uuid === null &&
    trunk.primary_uri_uuid === uriId &&
    trunk.fallback_uri_uuid === null
  );
}

function trunkMatchesDesired(
  trunk: z.infer<typeof PlivoTrunkSchema>,
  names: ManagedNames,
  uriId: string,
) {
  return (
    trunk.name === names.trunk &&
    trunk.trunk_status === "enabled" &&
    trunk.secure &&
    trunk.trunk_direction === "inbound" &&
    trunk.ipacl_uuid === null &&
    trunk.credential_uuid === null &&
    trunk.primary_uri_uuid === uriId &&
    trunk.fallback_uri_uuid === null
  );
}

function desiredPhoneProjection(
  bindings: PlivoPstnBindings,
  names: ManagedNames,
) {
  return {
    provider: "sip_trunk",
    phoneNumber: bindings.phoneNumber,
    label: names.phone,
    assignedAgent: {
      agentId: bindings.agentId,
      environment: "testing",
      branchId: bindings.branchId,
    },
    inboundTrunk: {
      allowedAddresses: ["0.0.0.0/0"],
      mediaEncryption: "required",
      hasAuthCredentials: false,
      remoteDomains: [],
      attributesToHeaders: {},
    },
    outboundConfigured: false,
    storeSipMessages: false,
  };
}

function phoneProjection(phone: z.infer<typeof ElevenSipPhoneSchema>) {
  const inbound = record(phone.inboundTrunk);
  const allowedAddresses = z
    .array(z.string())
    .safeParse(inbound.allowedAddresses);
  const remoteDomains = z.array(z.string()).safeParse(inbound.remoteDomains);
  return {
    provider: phone.provider,
    phoneNumber: phone.phoneNumber,
    label: phone.label,
    assignedAgent: phone.assignedAgent
      ? {
          agentId: phone.assignedAgent.agentId,
          environment: phone.assignedAgent.environment,
          branchId: phone.assignedAgent.branchId,
        }
      : null,
    inboundTrunk: {
      allowedAddresses: allowedAddresses.success
        ? [...allowedAddresses.data].sort()
        : [],
      mediaEncryption: inbound.mediaEncryption,
      hasAuthCredentials:
        typeof inbound.hasAuthCredentials === "boolean"
          ? inbound.hasAuthCredentials
          : false,
      remoteDomains: remoteDomains.success
        ? [...remoteDomains.data].sort()
        : [],
      attributesToHeaders: record(inbound.attributesToHeaders),
    },
    outboundConfigured:
      hasKeys(phone.outboundTrunk) || hasKeys(phone.providerConfig),
    storeSipMessages: phone.storeSipMessages ?? false,
  };
}

function phoneMatchesDesired(
  phone: z.infer<typeof ElevenSipPhoneSchema>,
  bindings: PlivoPstnBindings,
  names: ManagedNames,
) {
  return (
    digestJson(phoneProjection(phone)) ===
    digestJson(desiredPhoneProjection(bindings, names))
  );
}

function assertBranchFence(
  branch: ElevenLabsBranchFence,
  bindings: PlivoPstnBindings,
) {
  if (
    branch.agentId !== bindings.agentId ||
    branch.branchId !== bindings.branchId ||
    branch.versionId !== bindings.versionId ||
    branch.currentLivePercentage !== 0 ||
    branch.isMain
  ) {
    throw new Error(
      "The ElevenLabs development branch failed the Plivo resource fence",
    );
  }
}

function trunkApplicationResource(authId: string, trunkId: string) {
  return `/v1/Account/${authId}/Zentrunk/Trunk/${trunkId}/`;
}

function normalizedDigits(value: string) {
  return value.replace(/^\+/u, "");
}

function keyedDigest(secret: string, value: unknown) {
  return createHmac("sha256", secret)
    .update("buildlabs:plivo-reconciliation:v1:")
    .update(digestJson(value))
    .digest("hex");
}

function assertDigestEqual(expected: string, actual: string, message: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    if (message.startsWith("Plivo expected-base-digest")) {
      throw new PlivoPstnCasConflictError();
    }
    throw new Error(message);
  }
}

function assertProjectionEqual(
  current: unknown,
  desired: unknown,
  message: string,
) {
  if (digestJson(current) !== digestJson(desired)) {
    throw new Error(message);
  }
}

function hasKeys(value: JsonRecord | undefined) {
  return Boolean(value && Object.keys(value).length > 0);
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function firstString(...values: unknown[]) {
  return (
    values.find((value): value is string => typeof value === "string") ?? ""
  );
}
