import type { LoginEvent } from "./protocol";
import { openableLoginUrl } from "./store";

/**
 * One live MCP login offer for this thread: "Sign in to <server>" with a tap target that opens the
 * one-time authorization URL in the system browser.
 *
 * The URL only ever lives in memory, so a reload removes the card; the gateway's expiry and the
 * outcome notice remove it too (the store enforces both). Only an `https:` URL, or a loopback
 * `http:` one for local testing, is ever handed to `window.open`.
 */
export function LoginCard({ login }: { login: LoginEvent }) {
  if (!openableLoginUrl(login.url)) return null;
  const expiresAt = new Date(login.expiresAt);
  const expires = Number.isFinite(expiresAt.getTime())
    ? expiresAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : undefined;
  return (
    <div className="login-card" role="group" aria-label={`Sign in to ${login.server}`}>
      <span className="login-text">
        <b>Sign in to {login.server}</b>
        <small>{expires === undefined ? "One-time link" : `Link expires at ${expires}`} · not stored by the app</small>
      </span>
      <button className="login-open" onClick={() => {
        if (openableLoginUrl(login.url)) window.open(login.url, "_blank", "noopener,noreferrer");
      }}>Open</button>
    </div>
  );
}
