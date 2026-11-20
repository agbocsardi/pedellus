/**
 * Minimal types for the pinned `web-push` 4.0.0 dependency (it ships no declarations), covering
 * exactly the surface the app channel's push module uses. Runtime behavior is the library's.
 */
declare module "web-push" {
  export type PushSubscription = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  export type SendOptions = {
    ttl?: number;
    urgency?: string;
    topic?: string;
    timeout?: number;
  };
  export type SendResult = {
    statusCode: number;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  };
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer,
    options?: SendOptions,
  ): Promise<SendResult>;
}
