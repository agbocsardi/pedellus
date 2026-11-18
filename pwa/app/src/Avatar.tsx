import { memo, useState, useSyncExternalStore } from "react";

export type AvatarState = "idle" | "queued" | "thinking" | "tool" | "error" | "offline";

interface SpriteEntry {
  readonly hold: string;
  readonly accent?: string;
}

type SpriteMap = Partial<Record<AvatarState, SpriteEntry>>;

const AVATAR_STATES: readonly AvatarState[] = ["idle", "queued", "thinking", "tool", "error", "offline"];

let customSprites: SpriteMap | null = null;
let fetchStarted = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function validSpriteUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/avatar/");
}

function parseManifest(raw: unknown): SpriteMap | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.custom !== true || !obj.states || typeof obj.states !== "object") return null;
  const statesObj = obj.states as Record<string, unknown>;
  const map: SpriteMap = {};
  let count = 0;
  for (const state of AVATAR_STATES) {
    const entry = statesObj[state];
    if (!entry || typeof entry !== "object") continue;
    const { hold, accent } = entry as Record<string, unknown>;
    if (!validSpriteUrl(hold)) continue;
    map[state] = validSpriteUrl(accent) ? { hold, accent } : { hold };
    count++;
  }
  return count > 0 ? map : null;
}

function loadCustomSprites(): void {
  if (fetchStarted || typeof fetch !== "function" || typeof window === "undefined") return;
  fetchStarted = true;
  void fetch("/avatar/manifest.json", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const parsed = parseManifest(data);
      if (parsed) {
        customSprites = parsed;
        notify();
      }
    })
    .catch(() => {
      // Offline or unavailable: keep the built-in default robot.
    });
}

function subscribeSprites(listener: () => void): () => void {
  listeners.add(listener);
  loadCustomSprites();
  return () => {
    listeners.delete(listener);
  };
}

function getSprites(): SpriteMap | null {
  return customSprites;
}

interface DefaultPose {
  /** Body transform: [dx, dy, angle]. */
  body: [x: number, y: number, angle: number];
  /** Left and right eye style. */
  eyes: "open" | "blink" | "glance-right" | "squint" | "focus" | "error" | "shut";
  /** Eye offset inside the visor. */
  gaze?: [x: number, y: number];
  /** Antenna beacon state. */
  beacon: "on" | "bright" | "alert" | "off";
  /** Optional simple status accent outside the chassis. */
  extra?: "dots-a" | "dots-b" | "thought-a" | "thought-b" | "gear-a" | "gear-b" | "jolt" | "zzz";
}

const DEFAULT_POSES: Record<AvatarState, [hold: DefaultPose, accent: DefaultPose]> = {
  idle: [
    { body: [0, 0, 0], eyes: "open", gaze: [0, 0], beacon: "on" },
    { body: [0, 0.5, 0], eyes: "blink", gaze: [0, 0], beacon: "on" },
  ],
  queued: [
    { body: [-1, 0.5, -3], eyes: "glance-right", gaze: [2.2, 0.4], beacon: "on", extra: "dots-a" },
    { body: [-1, -0.5, -5], eyes: "glance-right", gaze: [2.4, -0.8], beacon: "bright", extra: "dots-b" },
  ],
  thinking: [
    { body: [1, 0.5, 4], eyes: "squint", gaze: [1.8, -1.2], beacon: "bright", extra: "thought-a" },
    { body: [1.5, 1, 6], eyes: "squint", gaze: [2.2, -1.6], beacon: "on", extra: "thought-b" },
  ],
  tool: [
    { body: [-1.5, 0, -5], eyes: "focus", gaze: [1.6, 0.8], beacon: "bright", extra: "gear-a" },
    { body: [-1, 0.8, -8], eyes: "focus", gaze: [2, 1], beacon: "on", extra: "gear-b" },
  ],
  error: [
    { body: [0, 1, -7], eyes: "error", beacon: "alert" },
    { body: [0, -2, -10], eyes: "error", beacon: "alert", extra: "jolt" },
  ],
  offline: [
    { body: [0, 4, 3], eyes: "shut", beacon: "off", extra: "zzz" },
    { body: [0, 3, 2], eyes: "shut", beacon: "off", extra: "zzz" },
  ],
};

function Eyes({ mode, gaze }: { mode: DefaultPose["eyes"]; gaze: [number, number] }) {
  const [gx, gy] = gaze;
  if (mode === "blink") {
    return (
      <>
        <path className="eye-line" d="M21 34.5q3-2.2 6 0" />
        <path className="eye-line" d="M37 34.5q3-2.2 6 0" />
      </>
    );
  }
  if (mode === "shut") {
    return (
      <>
        <path className="eye-shut" d="M21 35h6" />
        <path className="eye-shut" d="M37 35h6" />
      </>
    );
  }
  if (mode === "error") {
    return (
      <>
        <path className="eye-alarm" d="M21.5 31.5 26.5 36.5M26.5 31.5 21.5 36.5" />
        <path className="eye-alarm" d="M37.5 31.5 42.5 36.5M42.5 31.5 37.5 36.5" />
      </>
    );
  }
  const r = mode === "squint" ? 2.5 : mode === "focus" ? 2.7 : 3;
  return (
    <g transform={`translate(${gx} ${gy})`}>
      <circle className="iris" cx="24" cy="34" r={r} />
      <circle className="iris" cx="40" cy="34" r={r} />
      <circle className="glint" cx="23" cy="32.9" r="0.9" />
      <circle className="glint" cx="39" cy="32.9" r="0.9" />
      {mode === "squint" && (
        <>
          <path className="lid" d="M20 30.8h8v2.2h-8z" />
          <path className="lid" d="M36 30.8h8v2.2h-8z" />
        </>
      )}
      {mode === "focus" && (
        <>
          <path className="lid" d="M20 30.5 28 32.3v-2H20z" />
          <path className="lid" d="M44 30.5 36 32.3v-2H44z" />
        </>
      )}
    </g>
  );
}

function Extra({ kind }: { kind: DefaultPose["extra"] }) {
  if (!kind) return null;
  if (kind === "dots-a" || kind === "dots-b") {
    const dy = kind === "dots-b" ? -1.4 : 0;
    return (
      <g>
        <circle className="pip" cx="26" cy={56.5 + dy} r="1.4" />
        <circle className="pip" cx="32" cy={56.5 - dy * 0.6} r="1.4" />
        <circle className="pip" cx="38" cy={56.5 + dy} r="1.4" />
      </g>
    );
  }
  if (kind === "thought-a" || kind === "thought-b") {
    const shift = kind === "thought-b" ? -1 : 0;
    return (
      <g>
        <circle className="pip" cx="49" cy={16 + shift} r="1.4" />
        <circle className="pip" cx="54" cy={11.5 + shift} r="2.1" />
        <circle className="pip" cx="59" cy={6.5 + shift} r="2.7" />
      </g>
    );
  }
  if (kind === "gear-a" || kind === "gear-b") {
    const angle = kind === "gear-b" ? 30 : 0;
    return (
      <g transform={`translate(54 46) rotate(${angle})`}>
        <circle className="brass" cx="0" cy="0" r="5.2" />
        <path className="fine" d="M0-7.2v2.1M0 5.1v2.1M-7.2 0h2.1M5.1 0h2.1M-5.1-5.1l1.5 1.5M3.6 3.6l1.5 1.5M5.1-5.1l-1.5 1.5M-3.6 3.6l-1.5 1.5" />
        <circle className="visor" cx="0" cy="0" r="2.1" />
      </g>
    );
  }
  if (kind === "jolt") {
    return (
      <g>
        <path className="fine" d="M12 13 8.5 9.5M52 13 55.5 9.5" />
      </g>
    );
  }
  if (kind === "zzz") {
    return (
      <g className="sleep">
        <path className="fine" d="M47 16h4.5l-4.5 4.5h4.5" />
        <path className="fine" d="M54 9.5h3.5l-3.5 3.5h3.5" />
      </g>
    );
  }
  return null;
}

function DefaultFrame({ pose, accent }: { pose: DefaultPose; accent: boolean }) {
  const [dx, dy, angle] = pose.body;
  const beaconClass =
    pose.beacon === "alert"
      ? "beacon-alert"
      : pose.beacon === "off"
        ? "beacon-off"
        : pose.beacon === "bright"
          ? "beacon-bright"
          : "beacon";
  return (
    <g className={accent ? "avatar-accent" : "avatar-hold"}>
      <g transform={`translate(${32 + dx} ${34 + dy}) rotate(${angle}) translate(-32 -34)`}>
        {/* Antenna */}
        <path d="M32 19v-6.5" />
        <circle className={beaconClass} cx="32" cy="10" r="3" />
        {/* Side ear caps */}
        <rect className="ear" x="8.5" y="29" width="4.5" height="10" rx="2" />
        <rect className="ear" x="51" y="29" width="4.5" height="10" rx="2" />
        {/* Main rounded head / chassis */}
        <rect className="shell" x="13" y="19" width="38" height="30" rx="10" />
        <path className="shade" d="M45 20.5c3.2 1.8 5 5 5 8.8v10.2c0 4.8-3.8 8.5-8.5 8.5H21.5c2.2 0 18 0 21-2.5 3.8-3.2 4.3-16.8 2.5-25Z" />
        <path className="shine fine" d="M18.5 23.5c2-1.2 4.8-1.5 8.5-1.5" />
        {/* Recessed face visor */}
        <rect className="visor" x="17.5" y="26.5" width="29" height="15" rx="6.5" />
        <Eyes mode={pose.eyes} gaze={pose.gaze ?? [0, 0]} />
        {/* Chin seam / grille */}
        <path className="fine" d="M26 45h12" />
      </g>
      <Extra kind={pose.extra} />
    </g>
  );
}

// Chat can re-render on every streamed token. The two drawings only change
// when state or custom sprites change; no timers or document-global IDs.
export const Avatar = memo(function Avatar({ state }: { state: AvatarState }) {
  const sprites = useSyncExternalStore(subscribeSprites, getSprites, () => null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const custom = sprites?.[state] ?? sprites?.idle;
  const useCustom = custom !== undefined && failedUrl !== custom.hold;
  const hasAccent = useCustom ? custom.accent !== undefined : true;

  if (useCustom) {
    return (
      <span className="avatar" data-state={state} data-animated={hasAccent ? "true" : "false"} aria-hidden="true">
        <img
          key={`${state}-hold-${custom.hold}`}
          className="sprite avatar-hold"
          src={custom.hold}
          alt=""
          draggable={false}
          onError={() => setFailedUrl(custom.hold)}
        />
        {custom.accent && (
          <img
            key={`${state}-accent-${custom.accent}`}
            className="sprite avatar-accent"
            src={custom.accent}
            alt=""
            draggable={false}
            onError={() => setFailedUrl(custom.hold)}
          />
        )}
      </span>
    );
  }

  const [hold, accent] = DEFAULT_POSES[state];
  return (
    <span className="avatar" data-state={state} data-animated="true" aria-hidden="true">
      <svg key={state} viewBox="0 0 64 64" focusable="false">
        <DefaultFrame pose={hold} accent={false} />
        <DefaultFrame pose={accent} accent />
      </svg>
    </span>
  );
});
