import { useState } from "react";
import type { ActivityStep } from "./protocol";

/**
 * A turn's tool steps in three levels (protocol v2, "Activity"): a collapsed
 * "Used N tools" line, a compact list on tap, and one step's detail inline when
 * its row is tapped. Nothing here is a modal, so opening it never moves the
 * page; the rows are the tap targets.
 */
const OUTCOME: Record<ActivityStep["state"], string> = { running: "Running", done: "Done", failed: "Failed" };

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

function stamp(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "—" : CLOCK.format(date);
}

/** How long a step took; a running step shows the time so far. */
function span(step: ActivityStep): string {
  const start = Date.parse(step.startedAt);
  const end = step.endedAt === undefined ? Date.now() : Date.parse(step.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const ms = Math.max(0, end - start);
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

export function ActivitySteps({ steps, omitted, live }: {
  steps: ActivityStep[]; omitted?: number; live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const total = steps.length + (omitted ?? 0);
  return (
    <div className={live ? "activity is-live" : "activity"}>
      <button type="button" className="activity-toggle" aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setDetail(undefined);
        }}>
        <span className="activity-count">{total === 1 ? "Used 1 tool" : `Used ${total} tools`}</span>
        {omitted !== undefined && omitted > 0 && <span className="activity-omitted">· {omitted} not shown</span>}
        <span className="activity-chevron" aria-hidden="true">›</span>
      </button>
      {open && (
        <ul className="activity-list">
          {steps.map((step) => {
            const shown = detail === step.id;
            return (
              <li key={step.id}>
                <button type="button" className="activity-step" data-state={step.state} aria-expanded={shown}
                  onClick={() => setDetail(shown ? undefined : step.id)}>
                  <span className="activity-mark" aria-hidden="true">
                    {step.state === "running" ? <span className="activity-spinner" /> : step.state === "failed" ? "✕" : "✓"}
                  </span>
                  <span className="activity-tool">{step.tool}</span>
                  <span className="activity-time">{step.state === "running" ? "running" : span(step)}</span>
                </button>
                {shown && (
                  <dl className="activity-detail">
                    <div><dt>Tool</dt><dd>{step.tool}</dd></div>
                    <div><dt>Outcome</dt><dd>{OUTCOME[step.state]}</dd></div>
                    <div><dt>Started</dt><dd>{stamp(step.startedAt)}</dd></div>
                    <div><dt>Ended</dt><dd>{step.endedAt === undefined ? "—" : stamp(step.endedAt)}</dd></div>
                    <div><dt>Duration</dt><dd>{span(step) || "—"}</dd></div>
                  </dl>
                )}
              </li>
            );
          })}
          {omitted !== undefined && omitted > 0 &&
            <li className="activity-more">Earlier steps are summarised by the count above.</li>}
        </ul>
      )}
    </div>
  );
}
