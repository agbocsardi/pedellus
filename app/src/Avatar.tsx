/**
 * The agent's avatar: a hand-drawn doodle helper robot (original design: a
 * hovering kettle-shaped riveted steel body in a bowler hat, one big brass
 * camera-lens eye, noodle arms and a hover wisp; retro-futurist in feel). Each pose is drawn twice with slightly different wobble and
 * the two frames alternate ("line boil") while the agent works. Look and
 * motion live here and in the `.avatar` rules of styles.css; callers only
 * give it a sized slot (it fills its parent) and a state.
 */
import { memo, type ReactNode } from "react";

export type AvatarState = "idle" | "queued" | "thinking" | "tool" | "error" | "offline";

type F = 0 | 1;

/** Deterministic hand-drawn wobble: nudge every number in a path a little,
 *  differently per frame. Paths use only M/L/Q/C (no arc flags to break). */
function w(d: string, f: F, amp = 0.5): string {
  let i = 0;
  return d.replace(/-?\d*\.?\d+/g, (m) => {
    const x = Math.sin((f + 1) * 91.7 + i++ * 12.9898) * 43758.5453;
    return (parseFloat(m) + (x - Math.floor(x) - 0.5) * 2 * amp).toFixed(2);
  });
}

/** Circle as a path, drawn with a slight overshoot like a pen stroke. */
function circ(cx: number, cy: number, r: number, over = 0.18): string {
  const k = r * 0.552;
  return (
    `M${cx - r} ${cy} C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} ` +
    `C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} ` +
    `C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} ` +
    `C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy - r * over}`
  );
}

const S = (d: string, cls = "ln") => <path className={cls} d={d} />;

interface Pose {
  /** Pupil offset (where it looks). */
  look?: [number, number];
  /** Replaces the lens interior (closed eye, x eye). */
  eye?: string;
  /** Hat placement: [dx, dy, degrees]. */
  hat?: [number, number, number];
  arms: (f: F) => ReactNode;
  extra?: (f: F) => ReactNode;
  wisp?: boolean;
}

const POSES: Record<AvatarState, Pose> = {
  idle: {
    arms: (f) => (
      <>
        {S(w("M18 31 Q12 34 12.5 40.5", f))}
        {S(w(circ(12.5, 41.5, 1.5), f, 0.2), "fillink")}
        <g className="wave">
          {S(w("M46 31 Q52 34 51.5 40.5", f))}
          {S(w(circ(51.5, 41.5, 1.5), f, 0.2), "fillink")}
        </g>
      </>
    ),
  },
  queued: {
    look: [1.6, 1],
    arms: (f) => (
      <>
        {S(w("M18 31 Q12 33 15.5 37.5", f))}
        {S(w("M46 32 Q50 35 47.5 38.5", f))}
      </>
    ),
    extra: (f) => (
      <g>
        {S(w("M45.5 34 L54.5 35.5 L53 47.5 L44 46 Z", f, 0.35), "prop")}
        {S(w("M48 33.5 L52 34.2", f, 0.3), "ln thick")}
        {S(w("M47 39 L52 39.8 M46.6 42 L50.5 42.6", f, 0.3), "ln thin")}
        {S(w(circ(47.5, 39.5, 1.5), f, 0.2), "fillink")}
      </g>
    ),
  },
  thinking: {
    look: [-1.6, -1.8],
    arms: (f) => (
      <>
        {S(w("M18 33 Q20 43 27 40", f))}
        {S(w(circ(27.8, 39.6, 1.5), f, 0.2), "fillink")}
        {S(w(f ? "M46 32 Q53 35 51 41" : "M46 32 Q53 36 50.5 43", f))}
        {S(w(circ(f ? 51 : 50.5, f ? 42 : 44, 1.5), f, 0.2), "fillink")}
      </>
    ),
    extra: (f) => (
      <>
        {S(w(circ(46.5, 13.5, 1), f, 0.25), "fillink")}
        {S(w(circ(50.5, 9.5, 1.4), f, 0.25), "fillink")}
        {S(w(circ(55.5, 5, 1.9), f, 0.25), "fillink")}
      </>
    ),
  },
  tool: {
    look: [1.4, 2],
    arms: (f) => (
      <>
        {S(w("M18 32 Q12.5 36 16 41", f))}
        {S(w(circ(16.3, 42, 1.5), f, 0.2), "fillink")}
        {S(w(f ? "M46 32 Q52 37 46.5 42" : "M46 32 Q53 36 48 41", f))}
      </>
    ),
    extra: (f) => {
      const [x, y] = f ? [46.5, 42.5] : [48, 41.5];
      const a = f ? 0 : -1.2;
      return (
        <>
          {S(w(`M${x - 1} ${y - 1} L${x + 3} ${y + 3}`, f, 0.2), "grip")}
          {S(w(`M${x + 3} ${y + 3} L${x + 8 + a} ${y + 7.5 - a}`, f, 0.2), "ln thin")}
          {S(w(circ(x - 0.5, y - 0.5, 1.5), f, 0.2), "fillink")}
          {f === 0 && S(w(`M${x + 10} ${y + 4} L${x + 12} ${y + 3} M${x + 9.5} ${y + 7} L${x + 12} ${y + 7.5}`, f, 0.2), "ln thin spark")}
        </>
      );
    },
  },
  error: {
    hat: [0, -3.5, 8],
    eye: "M28.5 25.5 L35.5 32.5 M35.5 25.5 L28.5 32.5",
    arms: (f) => (
      <>
        {S(w(f ? "M18 30 Q11 28 10 21" : "M18 30 Q10.5 27 10.5 20.5", f))}
        {S(w(circ(10.3, 19.8, 1.5), f, 0.2), "fillink")}
        {S(w(f ? "M46 30 Q53 28 54 21" : "M46 30 Q53.5 27 53.5 20.5", f))}
        {S(w(circ(53.7, 19.8, 1.5), f, 0.2), "fillink")}
      </>
    ),
    extra: (f) => S(w("M48.5 11 Q51.5 15 49.6 16.6 Q47.3 16.3 48.5 11", f, 0.25), "ln thin"),
  },
  offline: {
    eye: "M24.5 28.6 Q32 27.4 39.5 28.6 M28.4 29.4 Q32 34.4 35.6 29.4",
    hat: [1, 2.5, -14],
    wisp: false,
    arms: (f) => (
      <>
        {S(w("M18 33 Q15.5 39 17 44.5", f))}
        {S(w(circ(17.2, 45.5, 1.5), f, 0.2), "fillink")}
        {S(w("M46 33 Q48.5 39 47 44.5", f))}
        {S(w(circ(46.8, 45.5, 1.5), f, 0.2), "fillink")}
      </>
    ),
    extra: (f) => (
      <g className="zz">
        {S(w("M45 13 L49 13 L45 17 L49 17", f, 0.2), "ln thin")}
        {S(w("M51 6 L54 6 L51 9 L54 9", f, 0.2), "ln thin")}
      </g>
    ),
  },
};

function Frame({ state, f }: { state: AvatarState; f: F }) {
  const p = POSES[state];
  const [lx, ly] = p.look ?? [0, 0];
  const [hx, hy, ha] = p.hat ?? [0, 0, 0];
  return (
    <g className={f ? "fr fb" : "fr fa"}>
      {p.wisp !== false &&
        S(w("M28.5 49 Q32 51.5 29.8 54.2 Q27.8 57 31.5 59 M35.5 49 Q33.2 52.2 35.6 55", f, 0.4), "ln thin wisp")}
      {S(w("M20.4 22.5 Q22.5 15 32 15 Q41.8 15 43.8 22 L46.6 38 Q47 46 32 46.2 Q17 46 17.4 38.2 L20.9 21.4", f), "body")}
      {S(w("M23.2 21 Q21.6 26 21.4 32", f, 0.3), "ln thin shine")}
      {S(w("M17.8 37.4 Q32 40.4 46.2 37.4", f, 0.35), "ln thin")}
      {[21.5, 26.5, 37.5, 42.5].map((x) => (
        <path key={x} className="fillink" d={w(circ(x, x < 30 ? 41.6 + (x - 21.5) * 0.12 : 42.2 - (x - 37.5) * 0.12, 0.75), f, 0.1)} />
      ))}
      {p.arms(f)}
      <g className="eye">
        {S(w(circ(32, 29, 8.4), f, 0.35), "brass")}
        {S(w(circ(32, 29, 5.3), f, 0.25), "glass")}
        {p.eye ? (
          S(w(p.eye, f, 0.3), state === "error" ? "ln bad" : "ln mark")
        ) : (
          <>
            {S(w(circ(32 + lx * 0.8, 29 + ly * 0.8, 3), f, 0.2), "iris")}
            {S(w(circ(32 + lx * 0.8, 29 + ly * 0.8, 1.5), f, 0.12), "pupil")}
            {S(w(circ(30.2 + lx * 0.5, 27.2 + ly * 0.5, 0.85), f, 0.1), "glint")}
          </>
        )}
      </g>
      <g transform={`translate(${hx} ${hy}) rotate(${ha} 32 15)`}>
        {S(w("M25.4 15 Q24.6 7.6 32 7.2 Q39.4 7.6 38.6 15", f, 0.35), "hat")}
        {S(w("M25.6 12.8 Q32 11.8 38.4 12.8", f, 0.25), "ln thin band")}
        {S(w("M21.6 15.8 Q32 12.6 42.4 15.8", f, 0.3), "ln thick")}
      </g>
      {p.extra?.(f)}
    </g>
  );
}

// Memoised: the paths never change for a state, and Chat re-renders on every
// streamed token.
export const Avatar = memo(function Avatar({ state }: { state: AvatarState }) {
  return (
    <span className="avatar" data-state={state} aria-hidden="true">
      <svg viewBox="7 3 50 54">
        <g className="bob">
          <Frame state={state} f={0} />
          <Frame state={state} f={1} />
        </g>
      </svg>
    </span>
  );
});
