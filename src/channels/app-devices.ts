/**
 * App device authority: the operator console (pairing codes, device and shortcut listing and
 * revocation), the single-use pairing exchange with its failure rate window, device-token
 * authentication, and the shortcut `POST /v1/ask` orchestration.
 *
 * Only hashes are stored: a device token lives in the device's cookie and a shortcut token is
 * returned once to the console. A shortcut token is its own credential class and reaches only
 * `POST /v1/ask`, which admits through the same path as a device `send`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Draft } from "@earendil-works/chord";
import { looksLikeOAuthCallback } from "../mcp/surface.js";
import { journalEvent } from "../observability.js";
import type { AppChannelState, AppCore, SendAdmission } from "./app.js";
import { APP_LIMITS, APP_MAIN_THREAD, APP_PAIR_ALPHABET, validAppLabel } from "./app-protocol.js";
import {
  APP_SHORTCUT_LIMITS,
  activeShortcut,
  askOutcomeForAdmissionError,
  createAskWaiters,
  createShortcutRateLimiter,
  hashShortcutToken,
  newAskKey,
  newShortcutToken,
  parseAskRequest,
  type AppAskOutcome,
  type AppShortcutCreated,
  type AppShortcutListing,
  type AppShortcutRefusal,
} from "./app-shortcuts.js";

/** Terminal pairing console results, rendered by `src/channels/app-operator-cli.ts`. */
export type AppPairingCreated = { readonly code: string; readonly expiresAtMs: number };
export type AppDeviceListing = {
  readonly label: string;
  readonly createdAtMs: number;
  readonly revokedAtMs?: number;
};
export type AppPairingRefusal = "label-in-use" | "device-limit" | "pairing-limit" | "invalid-label";

/** The operator console this adapter serves over the gateway's private local socket. */
export interface AppConsole {
  pair(label?: string): Promise<AppPairingCreated | { readonly refused: AppPairingRefusal }>;
  devices(): Promise<readonly AppDeviceListing[]>;
  revoke(label: string): Promise<"revoked" | "missing" | "invalid-label">;
  /** Create one shortcut token; it is returned once and only its hash is stored. */
  shortcutAdd(label: string): Promise<AppShortcutCreated | { readonly refused: AppShortcutRefusal }>;
  shortcuts(): Promise<readonly AppShortcutListing[]>;
  shortcutRevoke(label: string): Promise<"revoked" | "missing" | "invalid-label">;
}

export type AppPairRedeem =
  | { readonly status: "created"; readonly token: string }
  | { readonly status: "bad-request" }
  | { readonly status: "invalid" }
  | { readonly status: "rate-limited" };

export interface AppDevices {
  readonly console: AppConsole;
  pairRedeem(code: string, label: string): Promise<AppPairRedeem>;
  authenticate(token: string): Promise<{ deviceId: string; label: string } | undefined>;
  ask(token: string, request: unknown, requestSignal: AbortSignal | undefined): Promise<AppAskOutcome>;
  /** Resolve shortcut asks whose `settled` is now in the durable log; call after every append. */
  wake(): void;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Constant-time comparison of one presented value against a stored hex digest. */
function sameDigest(presented: string, storedHash: string): boolean {
  const known = Buffer.from(storedHash, "hex");
  const candidate = createHash("sha256").update(presented, "utf8").digest();
  return known.length === candidate.length && timingSafeEqual(known, candidate);
}

function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

function newPairingCode(): string {
  let code = "";
  const bytes = randomBytes(APP_LIMITS.pairCodeChars);
  for (let index = 0; index < APP_LIMITS.pairCodeChars; index += 1) {
    code += APP_PAIR_ALPHABET[bytes[index]! % APP_PAIR_ALPHABET.length]!;
  }
  return code;
}

/** The protocol alphabet without `I`/`O`, matched case-insensitively. */
function validPairingCode(code: string): boolean {
  if (code.length !== APP_LIMITS.pairCodeChars) return false;
  for (const character of code.toUpperCase()) {
    if (!APP_PAIR_ALPHABET.includes(character)) return false;
  }
  return true;
}

export function createAppDevices(options: {
  readonly core: AppCore;
  /** How long `POST /v1/ask` waits for its answer before answering `pending`. */
  readonly askWaitMs: number;
  /** The one owner-message admission path a device `send` uses; a shortcut has no device. */
  admitSend(deviceId: undefined, frame: Record<string, unknown>): Promise<SendAdmission>;
  /** Close a revoked device's live stream, if any. */
  closeDevice(deviceId: string): void;
}): AppDevices {
  const { core } = options;
  const { now } = core;
  /** Pairing failures inside the rolling one-minute window; in-memory, so a restart clears it. */
  const pairingFailures: number[] = [];
  /** Shortcut ask windows, per token hash; in-memory like the pairing failures. */
  const shortcutRate = createShortcutRateLimiter(now);
  /** Shortcut asks waiting for their durable `settled`; woken by every state commit. */
  const askWaiters = createAskWaiters(() => core.state().events);

  const prunePairings = (doc: Draft<AppChannelState>): void => {
    const nowMs = now();
    doc.pairings = doc.pairings.filter((pairing) => pairing.expiresAtMs > nowMs);
  };

  const labelInUse = (doc: Draft<AppChannelState>, label: string): boolean =>
    doc.devices.some((device) => device.revokedAtMs === undefined && device.label === label) ||
    doc.pairings.some((pairing) => pairing.label === label);

  const consoleHost: AppConsole = {
    async pair(label) {
      const trimmed = label === undefined ? undefined : label.trim();
      if (trimmed !== undefined && !validAppLabel(trimmed)) return { refused: "invalid-label" };
      let created: AppPairingCreated | undefined;
      let refused: AppPairingRefusal | undefined;
      let chosenLabel = "";
      await core.mutateState((doc) => {
        prunePairings(doc);
        if (doc.devices.filter((device) => device.revokedAtMs === undefined).length >= APP_LIMITS.maxDevices) {
          refused = "device-limit";
          return;
        }
        if (doc.pairings.length >= APP_LIMITS.maxPairings) {
          refused = "pairing-limit";
          return;
        }
        // Without a console label the device names itself at redemption (any valid label not
        // already used by an active device); with one, the device must send exactly that label.
        const chosen = trimmed;
        if (chosen !== undefined && labelInUse(doc, chosen)) {
          refused = "label-in-use";
          return;
        }
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const code = newPairingCode();
          const hash = sha256(code);
          if (doc.pairings.some((pairing) => pairing.codeHash === hash)) continue;
          doc.pairings.push({
            codeHash: hash,
            ...(chosen === undefined ? {} : { label: chosen }),
            createdAtMs: now(),
            expiresAtMs: now() + APP_LIMITS.pairTtlMs,
          });
          chosenLabel = chosen ?? "";
          created = { code, expiresAtMs: now() + APP_LIMITS.pairTtlMs };
          return;
        }
        refused = "pairing-limit";
      });
      if (refused !== undefined) return { refused };
      journalEvent("app.pairing.created", chosenLabel === "" ? {} : { "pairing.label": chosenLabel });
      return created!;
    },
    async devices() {
      return core.state().devices
        .map((device) => ({
          label: device.label,
          createdAtMs: device.createdAtMs,
          ...(device.revokedAtMs === undefined ? {} : { revokedAtMs: device.revokedAtMs }),
        }))
        .sort((left, right) => left.createdAtMs - right.createdAtMs);
    },
    async revoke(label) {
      if (!validAppLabel(label)) return "invalid-label";
      let revokedId: string | undefined;
      await core.mutateState((doc) => {
        const entry = doc.devices.find((device) => device.revokedAtMs === undefined && device.label === label);
        if (entry === undefined) return;
        entry.revokedAtMs = now();
        // The subscription is device authority: revoking the device drops it with the token.
        delete entry.pushSubscription;
        revokedId = entry.id;
      });
      if (revokedId === undefined) return "missing";
      options.closeDevice(revokedId);
      journalEvent("app.device.revoked", { "device.label": label });
      return "revoked";
    },
    async shortcutAdd(label) {
      const trimmed = label.trim();
      if (!validAppLabel(trimmed)) return { refused: "invalid-label" };
      let created: AppShortcutCreated | undefined;
      let refused: AppShortcutRefusal | undefined;
      await core.mutateState((doc) => {
        const current = doc.shortcuts ?? [];
        if (current.filter((entry) => entry.revokedAtMs === undefined).length >= APP_SHORTCUT_LIMITS.maxShortcuts) {
          refused = "shortcut-limit";
          return;
        }
        if (current.some((entry) => entry.revokedAtMs === undefined && entry.label === trimmed)) {
          refused = "label-in-use";
          return;
        }
        const token = newShortcutToken();
        const createdAtMs = now();
        // The token is returned once to the console and never stored: only its hash joins the state.
        doc.shortcuts = [...current, { label: trimmed, tokenHash: hashShortcutToken(token), createdAtMs }];
        created = { label: trimmed, token, createdAtMs };
      });
      if (refused !== undefined) return { refused };
      // The token is never journalled; the journal's projection does not carry labels either.
      journalEvent("app.shortcut.created");
      return created!;
    },
    async shortcuts() {
      return (core.state().shortcuts ?? [])
        .map((entry) => ({
          label: entry.label,
          createdAtMs: entry.createdAtMs,
          ...(entry.revokedAtMs === undefined ? {} : { revokedAtMs: entry.revokedAtMs }),
        }))
        .sort((left, right) => left.createdAtMs - right.createdAtMs);
    },
    async shortcutRevoke(label) {
      if (!validAppLabel(label)) return "invalid-label";
      let revoked = false;
      await core.mutateState((doc) => {
        const entry = (doc.shortcuts ?? []).find((item) => item.revokedAtMs === undefined && item.label === label);
        if (entry === undefined) return;
        entry.revokedAtMs = now();
        revoked = true;
      });
      if (!revoked) return "missing";
      journalEvent("app.shortcut.revoked");
      return "revoked";
    },
  };

  /** Rolling failure window for `POST /v1/pair`; in-memory, so a restart clears it. */
  const expireFailures = (): void => {
    const nowMs = now();
    while (pairingFailures.length > 0 && nowMs - pairingFailures[0]! >= APP_LIMITS.pairRateWindowMs) {
      pairingFailures.shift();
    }
  };
  const countPairingFailure = (): void => {
    expireFailures();
    pairingFailures.push(now());
  };
  const pairingRateLimited = (): boolean => {
    expireFailures();
    return pairingFailures.length > APP_LIMITS.pairRateMax;
  };

  async function pairRedeem(code: string, label: string): Promise<AppPairRedeem> {
    if (pairingRateLimited()) return { status: "rate-limited" };
    if (!validPairingCode(code) || !validAppLabel(label)) {
      countPairingFailure();
      return { status: "bad-request" };
    }
    let token: string | undefined;
    await core.mutateState((doc) => {
      prunePairings(doc);
      const pairing = doc.pairings.find((entry) => sameDigest(code.toUpperCase(), entry.codeHash));
      if (pairing === undefined) return;
      if (pairing.label !== undefined && pairing.label !== label) return;
      if (doc.devices.some((device) => device.revokedAtMs === undefined && device.label === label)) return;
      // An unlabelled code cannot take a label another outstanding code was created for.
      if (pairing.label === undefined && doc.pairings.some((entry) => entry !== pairing && entry.label === label)) return;
      if (doc.devices.filter((device) => device.revokedAtMs === undefined).length >= APP_LIMITS.maxDevices) return;
      // Single use: the code is consumed exactly when the device record is created.
      doc.pairings = doc.pairings.filter((entry) => !sameDigest(code.toUpperCase(), entry.codeHash));
      token = newDeviceToken();
      doc.devices.push({
        id: randomBytes(16).toString("hex"),
        label,
        tokenHash: sha256(token),
        createdAtMs: now(),
      });
    });
    if (token === undefined) {
      countPairingFailure();
      return { status: "invalid" };
    }
    journalEvent("app.device.paired", { "device.label": label });
    return { status: "created", token };
  }

  async function authenticate(token: string): Promise<{ deviceId: string; label: string } | undefined> {
    if (token.length === 0 || token.length > 256) return undefined;
    const device = core.state().devices.find((entry) =>
      entry.revokedAtMs === undefined && sameDigest(token, entry.tokenHash));
    return device === undefined ? undefined : { deviceId: device.id, label: device.label };
  }

  /**
   * `POST /v1/ask`: one shortcut token admits one owner message through the same `admitSend` path
   * as a device `send` (same bounds, idempotency by key, echo event and pending record, so every
   * paired device sees the message and its answer), then waits up to `askWaitMs` for that key's
   * durable `settled`. A shortcut token reaches nothing else: not the stream, files, pairing, push
   * or controls.
   */
  async function ask(token: string, request: unknown, requestSignal: AbortSignal | undefined): Promise<AppAskOutcome> {
    // Unknown and revoked tokens are indistinguishable: both are simply not an active shortcut.
    const shortcut = activeShortcut(core.state().shortcuts, token);
    if (shortcut === undefined) return { status: "unauthorized" };
    // Only an authenticated token spends its own window; an unknown one never reaches this point.
    if (!shortcutRate.allow(shortcut.tokenHash)) return { status: "rate-limited" };
    const parsed = parseAskRequest(request);
    if (parsed.kind !== "ok") return { status: parsed.kind };
    // Callback-shaped text is taken by a device `send` before admission and offered to the MCP
    // login lifecycle; it never becomes a turn, so no `settled` could ever arrive for it. An ask
    // cannot start a login exchange either, so it is refused up front as a bad request.
    if (looksLikeOAuthCallback(parsed.request.text)) return { status: "bad-request" };
    if (core.stopped()) return { status: "internal" };
    const thread = parsed.request.thread ?? APP_MAIN_THREAD;
    const key = parsed.request.key ?? newAskKey();
    const admission = await options.admitSend(undefined, { thread, key, text: parsed.request.text });
    if (admission.kind === "stopped") return { status: "internal" };
    if (admission.kind === "error") return askOutcomeForAdmissionError(admission.error);
    const waited = await askWaiters.wait(thread, key, options.askWaitMs, requestSignal);
    if (waited.outcome === "answered") return { status: "answered", text: waited.text };
    // Still running: the answer arrives in the app as usual, and the caller gets the admitted key.
    if (waited.outcome === "timeout") return { status: "pending", key };
    return { status: waited.outcome };
  }

  return { console: consoleHost, pairRedeem, authenticate, ask, wake: () => askWaiters.wake() };
}
