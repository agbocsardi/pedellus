import { canRun, type CommandState } from "./chat-shared";
import type { CommandInfo } from "./protocol";

export const REMOVE_ICON = "M6 6l12 12M18 6 6 18";
export const FILE_ICON = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5";
export const IMAGE_ICON = "M4 5h16v14H4zM4 16l4-4 3 3 3-3 6 6M15 10h.01";
export const AUDIO_ICON = "M4 12h2M8 8v8M12 5v14M16 8v8M20 12h2";
export const PLUS_ICON = "M12 5v14M5 12h14";
export const SEND_ICON = "M12 19V5M5.5 11.5 12 5l6.5 6.5";

const COMMAND_ICONS: Record<string, string> = {
  new: PLUS_ICON,
  status: "M3 12h4l3-8 4 16 3-8h4",
  abort: REMOVE_ICON,
  model: "M8 8h8v8H8zM10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3",
  digest: "M5 6h14M5 12h14M5 18h9",
  compact: "M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5",
  help: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
};
const COMMAND_ICON = "M15 4 9 20";

export function Icon({ d, bold }: { d: string; bold?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={bold ? 2.6 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SheetItem(props: { icon: string; title: string; sub?: string; disabled?: boolean; blocked?: boolean; onClick: () => void }) {
  return (
    <button className={props.blocked ? "sheet-item is-blocked" : "sheet-item"} disabled={props.disabled} onClick={props.onClick}>
      <span className="sheet-icon">
        <Icon d={props.icon} />
      </span>
      <span>
        <b>{props.title}</b>
        {props.sub && <small>{props.sub}</small>}
      </span>
    </button>
  );
}

export function CommandItem({ c, state, active, keepFocus, onClick }: {
  c: CommandInfo; state: CommandState; active?: boolean; keepFocus?: boolean; onClick: () => void;
}) {
  return (
    <button className="sheet-item command-item" disabled={!canRun(c, state)} aria-current={active || undefined}
      tabIndex={keepFocus ? -1 : undefined} onPointerDown={keepFocus ? (e) => e.preventDefault() : undefined} onClick={onClick}>
      <span className="sheet-icon"><Icon d={COMMAND_ICONS[c.name] ?? COMMAND_ICON} /></span>
      <span>
        <b>/{c.name}{c.args && <span className="command-args"> {c.args}</span>}</b>
        <small>{c.summary}</small>
      </span>
    </button>
  );
}
