/**
 * Minimal types for the pinned `web-push` 4.0.0 dependency (it ships no declarations), covering
 * exactly the surface the app channel's push module uses. Runtime behavior is the library's.
 */
declare module "web-push" {
  import type { Agent } from "node:https";

  export type PushSubscription = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  export type VapidDetails = {
    subject: string;
    publicKey: string;
    privateKey: string;
  };
  /** Exactly the keys `sendNotification` validates; any other key throws before any I/O. */
  export type SendOptions = {
    headers?: Record<string, string>;
    gcmAPIKey?: string | null;
    vapidDetails?: VapidDetails | null;
    TTL?: number;
    contentEncoding?: string;
    urgency?: string;
    topic?: string;
    proxy?: string | { host: string; port?: number | string };
    agent?: Agent;
    timeout?: number;
  };
  export type SendResult = {
    statusCode: number;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  };
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function generateRequestDetails(
    subscription: PushSubscription,
    payload?: string | Buffer,
    options?: SendOptions,
  ): {
    method: string;
    headers: Record<string, string | number>;
    body: Buffer | null;
    endpoint: string;
    timeout?: number;
  };
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer,
    options?: SendOptions,
  ): Promise<SendResult>;
}
