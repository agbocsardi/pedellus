import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { presetName, ready, type CommandState } from "./chat-shared";
import type { Connection } from "./conn";
import { LIMITS, validThreadTitle, type CommandInfo, type PresetInfo, type ThreadOrigin } from "./protocol";
import { pushPermission, refreshPush, togglePush, type PushPermission } from "./push";
import type { Store } from "./store";
import { TasksSheet } from "./TasksSheet";
import { ThreadList } from "./ThreadList";
import { CommandItem, Icon, PLUS_ICON, SheetItem } from "./ui";

export type Sheet = { kind: "list" | "menu" | "tools" | "tasks" | "confirm-new" | "model" } | { kind: "rename"; title: string }
  | { kind: "create"; title: string; from?: ThreadOrigin }
  | { kind: "message"; title: string; from: ThreadOrigin };

const LIST_ICON = "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01";
const BELL_ICON = "M18 14v-3.5a6 6 0 1 0-12 0V14l-2 3.5h16L18 14M10 21h4";
const TASKS_ICON = "M4 6h3l1.5 3L12 5M4 14h3l1.5 3L12 13M16 7h4M16 15h4";
const CHECK_ICON = "M5 12.5 10 17 19 7";

const TITLES: Record<Sheet["kind"], string> = {
  list: "Threads", menu: "Thread menu", tasks: "Tasks", message: "Message actions", tools: "Commands",
  model: "Model", "confirm-new": "New context", rename: "Rename thread", create: "New thread",
};

/** A typed title the gateway would refuse; blank is "no title" for a new thread. */
export const badTitle = (title: string) => title.trim() !== "" && !validThreadTitle(title.trim());

/** The open sheet: one modal, its content chosen by `sheet.kind`. */
export function SheetHost(props: {
  sheet: Sheet; opener: HTMLElement | null; store: Store; conn: Connection; thread: string;
  wide: boolean; online: boolean; writable: boolean; archived: boolean; main: boolean; title: string;
  busy: boolean; error: string; commands: CommandInfo[]; cmdState: CommandState; presets: PresetInfo[];
  model: string | null | undefined; pendingModel: string | undefined;
  dismiss: () => void;
  show: (next: Sheet) => void;
  select: (thread: string) => void;
  command: (name: string) => void;
  runCommand: (c: CommandInfo) => void;
  toggleArchive: () => void;
  saveTitle: (title: string) => void;
}) {
  const { sheet, store, conn, thread, online, writable, archived, cmdState, commands, model, pendingModel } = props;
  return (
    <Modal opener={props.opener} panel={sheet.kind} title={TITLES[sheet.kind]} dismiss={props.dismiss}>
      <div className="sheet-grip" aria-hidden="true" />
      {sheet.kind === "list" && !props.wide && <ThreadList store={store} conn={conn} online={online}
        onNew={() => props.show({ kind: "create", title: "" })} onSelect={props.select} />}
      {sheet.kind === "menu" && <>
        {writable && <>
          {commands.some((c) => c.name === "new") && <SheetItem icon={PLUS_ICON} title="New context"
            sub="Start fresh; earlier messages stay above a divider" disabled={!online} onClick={() => props.show({ kind: "confirm-new" })} />}
          {commands.some((c) => c.name === "status") && <SheetItem icon="M3 12h4l3-8 4 16 3-8h4" title="Status"
            sub="Ask the agent what it is doing" disabled={!online} onClick={() => props.command("status")} />}
        </>}
        <NotificationsItem store={store} conn={conn} online={online} />
        <SheetItem icon={TASKS_ICON} title="Tasks" sub="Workers and scheduled jobs in this thread"
          disabled={!online} onClick={() => props.show({ kind: "tasks" })} />
        {!props.main && (writable || archived) && <>
          <SheetItem icon="M4 20h4L20 8l-4-4L4 16v4Z" title="Rename thread" disabled={!online || props.busy}
            onClick={() => props.show({ kind: "rename", title: props.title })} />
          <SheetItem icon="M4 9h16v11H4zM3 4h18v5H3zM10 13h4" title={archived ? "Restore thread" : "Archive thread"}
            sub={archived ? "Make this thread writable again" : "Keep the history, but stop new messages"}
            disabled={!online || props.busy} onClick={props.toggleArchive} />
        </>}
        {!online && <p className="sheet-help">Reconnect to use these controls.</p>}
        {!writable && !archived && <p className="sheet-help">Thread details are not available.</p>}
      </>}
      {sheet.kind === "tasks" && <TasksSheet store={store} conn={conn} thread={thread} online={online} archived={archived} />}
      {sheet.kind === "tools" && <>
        <h2 className="sheet-heading">Commands</h2>
        {commands.map((c) => <CommandItem key={c.name} c={c} state={cmdState} onClick={() => props.runCommand(c)} />)}
        {!online && <p className="sheet-help">Reconnect to use commands.</p>}
      </>}
      {sheet.kind === "model" && <>
        <h2 className="sheet-heading">Model</h2>
        {props.presets.map((p) => {
          const current = p.name === model;
          return <button key={p.name} className="sheet-item preset-item" disabled={!ready(cmdState)}
            aria-current={current || undefined} onClick={() => {
              if (!current || pendingModel) conn.selectPreset(thread, p.name);
              props.dismiss();
            }}>
            <span className="preset-text">
              <b>{presetName(p)}</b>
              <small><span className="preset-model">{p.model}</span>{p.thinking && <span className="nowrap"> · thinking {p.thinking}</span>}</small>
            </span>
            {p.name === pendingModel ? <small className="preset-pending">Switching…</small>
              : current && <span className="preset-check" role="img" aria-label="Current"><Icon d={CHECK_ICON} bold /></span>}
          </button>;
        })}
        {model === null && <p className="sheet-help">This thread uses a custom model.</p>}
        {!online && <p className="sheet-help">Reconnect to switch models.</p>}
      </>}
      {sheet.kind === "confirm-new" && <>
        <h2 className="sheet-heading">Start a new context?</h2>
        <p className="sheet-help">The agent starts fresh. Earlier messages stay above a divider.</p>
        <button className="primary confirm" disabled={!ready(cmdState)} onClick={() => props.command("new")}>
          Start new context
        </button>
      </>}
      {sheet.kind === "message" && <SheetItem icon={LIST_ICON} title="Start side thread from here"
        sub="Fork the conversation at this message"
        onClick={() => props.show({ kind: "create", title: sheet.title, from: sheet.from })} />}
      {(sheet.kind === "create" || sheet.kind === "rename") && (
        <ThreadTitleForm key={sheet.kind} kind={sheet.kind} initial={sheet.title} busy={props.busy} online={online} save={props.saveTitle} />
      )}
      {props.error && <p className="error-text" role="alert">{props.error}</p>}
      <button className="sheet-cancel" onClick={props.dismiss}>
        {sheet.kind === "list" || sheet.kind === "tasks" ? "Done" : "Cancel"}
      </button>
    </Modal>
  );
}

function Modal({ title, panel, opener, dismiss, children }: {
  title: string; panel: Sheet["kind"]; opener: HTMLElement | null; dismiss: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const selector = panel === "list" ? ".thread-search" : panel === "create" || panel === "rename" ? "#thread-title" : ".sheet-item:not(:disabled)";
    (dialog.querySelector<HTMLElement>(selector) ?? dialog.querySelector<HTMLElement>(".sheet-cancel"))?.focus();
  }, [panel]);
  return (
    <dialog ref={ref} className="sheet-layer" aria-label={title}
      onCancel={(e) => { e.preventDefault(); dismiss(); }}
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
      <div className="sheet">{children}</div>
    </dialog>
  );
}

function ThreadTitleForm({ kind, initial, busy, online, save }: {
  kind: "create" | "rename"; initial: string; busy: boolean; online: boolean; save: (title: string) => void;
}) {
  const [title, setTitle] = useState(initial);
  const create = kind === "create";
  return <form className="thread-form" onSubmit={(e) => { e.preventDefault(); save(title); }}>
    <h2 className="sheet-heading">{create ? "New thread" : "Rename thread"}</h2>
    <label htmlFor="thread-title">{create ? "Title (optional)" : "Title"}</label>
    <input id="thread-title" value={title} onChange={(e) => setTitle(e.target.value)}
      maxLength={LIMITS.threadTitleChars} placeholder="New thread" />
    {!online && <p className="sheet-help">{create ? "This thread will sync when you reconnect." : "Reconnect to rename this thread."}</p>}
    <button className="primary" disabled={busy || badTitle(title) || (!create && (!online || !title.trim()))}>
      {create ? "Create thread" : "Save title"}
    </button>
  </form>;
}

/**
 * Push is a device setting, so it lives in the thread menu. It asks for permission only on a tap
 * and hides itself once the gateway answers `unsupported` (protocol v2, "Notifications (Web
 * Push)"). The enrolment handshake itself lives in `push.ts`.
 */
function NotificationsItem({ store, conn, online }: { store: Store; conn: Connection; online: boolean }) {
  const [permission, setPermission] = useState<PushPermission>(pushPermission);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // Learn the gateway's answer while the menu is open, so an unconfigured gateway never shows
  // the row; a rotated VAPID key rebuilds a subscription the owner already turned on.
  useEffect(() => {
    let live = true;
    let renewing = false;
    void refreshPush(store, conn, () => {
      renewing = true;
      if (live) setBusy(true);
    }).then((outcome) => {
      if (!live) return;
      if (outcome?.permission) setPermission(outcome.permission);
      if (outcome?.note) setNote(outcome.note);
    }).finally(() => {
      if (live && renewing) setBusy(false);
    });
    return () => { live = false; };
  }, [store, conn]);
  if (store.push.gatewayUnsupported) return null;
  const on = !!store.push.endpoint;

  async function toggle() {
    if (busy || permission === "denied" || permission === "unsupported") return;
    setBusy(true);
    setNote("");
    try {
      const outcome = await togglePush(store, conn, online);
      if (outcome.permission) setPermission(outcome.permission);
      setNote(outcome.note ?? "");
    } finally {
      setBusy(false);
    }
  }

  const blocked = permission === "unsupported" || permission === "denied";
  const sub = permission === "unsupported"
    ? "Not available in this browser. On iPhone, add the app to the home screen first"
    : permission === "denied"
      ? "Blocked. Allow notifications for this app in your browser settings"
      : on ? (online ? "On for new messages. Tap to turn off" : "On for new messages. Reconnect to turn off")
      : online ? "Off. Tap to turn on" : "Off. Reconnect to turn on";
  return <>
    <SheetItem icon={BELL_ICON} title="Notifications" sub={sub} blocked={blocked}
      disabled={busy || blocked} onClick={() => void toggle()} />
    {/* A blocked or unsupported row explains itself; a note would only repeat it. */}
    {note && !blocked && <p className="sheet-help" role="status">{note}</p>}
  </>;
}
