import {
  useEffect, useEffectEvent, useImperativeHandle, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type Ref, type RefObject,
} from "react";
import { lengthText } from "./Attachments";
import { canRun, FINE_POINTER, SLASH, type CommandState } from "./chat-shared";
import type { Connection } from "./conn";
import { LIMITS, type CommandInfo, type ThreadInfo } from "./protocol";
import { canRecord } from "./recorder";
import type { NewAttachment, Store } from "./store";
import { archivedLabel } from "./ThreadList";
import { AUDIO_ICON, CommandItem, FILE_ICON, Icon, IMAGE_ICON, PLUS_ICON, REMOVE_ICON, SEND_ICON } from "./ui";
import { attachmentKind, formatBytes, forgetUpload, ownUploads, releaseUpload, uploadLocal } from "./uploads";
import { useVoiceRecorder } from "./useVoiceRecorder";

const WRENCH_ICON = "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z";
const MIC_ICON = "M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3M5 11a7 7 0 0 0 14 0M12 18v3";

/** A file picked in the composer and not yet sent. */
type Pick = {
  id: string; file: File; name: string; type: string; size: number;
  state: "waiting" | "uploading" | "done" | "failed"; uploadId?: string; note?: string; preview?: string;
  /** Seconds, for a pick that came from the recorder: its chip names it by length, not by file. */
  voice?: number;
};

const toNewAttachment = (pick: Pick): NewAttachment => ({
  id: pick.id, name: pick.name, type: pick.type, size: pick.size, blob: pick.file,
  ...(pick.uploadId ? { uploadId: pick.uploadId } : {}),
});

const newId = () => crypto.randomUUID().replaceAll("-", "");

function pickLabel(pick: Pick) {
  switch (pick.state) {
    case "uploading": return "Uploading…";
    case "waiting": return pick.note ?? "Waiting for connection";
    case "failed": return "Upload failed";
    default: return "Ready";
  }
}

/** What the chat screen asks of the composer. */
export type ComposerHandle = {
  /** Put `text` in this thread's draft (a command's `/name `). */
  fill(text: string): void;
  /** Drop a `/…` draft once its command ran from elsewhere. */
  clearSlash(): void;
  focus(): void;
  blur(): void;
  /** Queue a failed message again under a fresh key. */
  retry(text: string, key: string): void;
};

/**
 * The composer: per-thread drafts and picked files, the `/` command list, eager uploads, the
 * voice note recorder and the send/stop/mic button. Drafts live here, not in the chat screen, so
 * a keystroke re-renders only this footer.
 */
export function Composer({
  ref, store, conn, thread, info, online, writable, running, sheetOpen, toolsOpen, error, forkError, setError,
  busy, pinned, wrenchRef, commands, cmdState, onTools, onRunCommand, onRestore,
}: {
  ref: Ref<ComposerHandle>;
  store: Store; conn: Connection; thread: string; info: ThreadInfo | undefined;
  online: boolean; writable: boolean; running: boolean;
  sheetOpen: boolean; toolsOpen: boolean;
  error: string; forkError: string; setError: (message: string) => void;
  busy: boolean;
  pinned: RefObject<boolean>;
  wrenchRef: RefObject<HTMLButtonElement | null>;
  commands: CommandInfo[]; cmdState: CommandState;
  onTools: (trigger: HTMLElement) => void;
  onRunCommand: (c: CommandInfo, args?: string) => void;
  onRestore: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<string, Pick[]>>({});
  /** A short, non-error explanation (a recording that stopped on its own). */
  const [hint, setHint] = useState("");
  const [slashPick, setSlashPick] = useState(0);
  const [slashHidden, setSlashHidden] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const uploading = useRef(new Set<string>());
  const previews = useRef(new Set<string>());

  const archived = !!info?.archived;
  const agentName = store.agentName;
  const text = drafts[thread] ?? "";
  const setText = (value: string) => setDrafts((prev) => ({ ...prev, [thread]: value }));
  const files = picks[thread] ?? [];
  const canSendFiles = files.every((f) => f.state !== "failed");
  const canVoice = store.uploads && canRecord();
  const slash = SLASH.exec(text);
  const typed = slash?.[1].toLowerCase() ?? "";
  const args = slash?.[2]; // undefined until a space follows the name
  const matches = !slash ? [] : args === undefined ? commands.filter((c) => c.name.startsWith(typed))
    : commands.filter((c) => c.name === typed);
  const picked: CommandInfo | undefined = matches[args === undefined ? Math.min(slashPick, matches.length - 1) : 0];
  const argsTooLong = (args?.trim().length ?? 0) > LIMITS.controlArgsChars;
  const slashOpen = !!slash && writable && !sheetOpen && !slashHidden;

  const recorder = useVoiceRecorder({
    store, thread, writable, busy: () => saving.current, setError, setHint,
    queue: (file) => queueMessage("", undefined, [{
      id: newId(), file, name: file.name, type: file.type, size: file.size, state: "done",
    }]),
    keep: (file, threadId, secs) => addFiles([file], threadId, secs),
  });

  useImperativeHandle(ref, () => ({
    fill(value) {
      setText(value);
      setSlashPick(0);
      setSlashHidden(false);
    },
    clearSlash() {
      if (SLASH.test(text)) setText("");
    },
    focus: () => taRef.current?.focus(),
    blur: () => taRef.current?.blur(),
    retry: (value, key) => void queueMessage(value, key),
  }));

  useEffect(() => { setSlashHidden(false); }, [thread]);
  // Composer previews are object URLs; release every one the app still holds.
  useEffect(() => () => {
    for (const url of previews.current) URL.revokeObjectURL(url);
    previews.current.clear();
  }, []);
  // Files picked while offline (or paused by a rate limit) upload once the
  // stream comes back. Only a transition retries them: reacting to each pick
  // update would loop while an upload keeps failing.
  const uploadWindow = useRef({ online, thread });
  const resumeUploads = useEffectEvent(() => {
    if (!online || !store.uploads) return;
    for (const pick of picks[thread] ?? []) if (pick.state === "waiting") void runUpload(thread, pick);
  });
  useEffect(() => {
    const prev = uploadWindow.current;
    uploadWindow.current = { online, thread };
    if (online && (!prev.online || prev.thread !== thread)) resumeUploads();
  }, [online, thread]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [text, thread, writable]);

  async function submit() {
    if (!store.canWrite(thread)) return;
    if (slash) {
      runSlash();
      return;
    }
    const t = text.trim();
    if ((!t && !files.length) || t.length > LIMITS.sendTextChars) return;
    if (!canSendFiles) {
      setError("Remove the files that could not be uploaded, then send.");
      return;
    }
    await queueMessage(t, undefined, files);
  }

  async function queueMessage(value: string, retryKey?: string, attach?: Pick[]) {
    if (saving.current || !store.canWrite(thread)) return;
    saving.current = true;
    setError("");
    // Pin first: `createOutgoing` publishes the new row, and the list may commit it before the
    // await below resumes; a pin set after that would leave the bubble out of view.
    pinned.current = true;
    const sent = attach?.map(toNewAttachment);
    try {
      // The chosen files belong to the send from here, ahead of the IndexedDB await: whatever an
      // eager upload lands while the entry is being written stays theirs, and a remove tapped
      // mid-handoff cannot discard an accepted id and force a second POST of the same bytes.
      if (sent?.length) ownUploads(sent.map((file) => file.id));
      const m = await store.createOutgoing(thread, value, retryKey, sent);
      // An id the entry already carries is frozen on it now; one that finished uploading after
      // the snapshot stays with the uploader, which the outbox pass asks before uploading again.
      for (const file of sent ?? []) if (file.uploadId) releaseUpload(file.id);
      if (!retryKey) setDrafts((prev) => prev[thread] === text ? { ...prev, [thread]: "" } : prev);
      // The files now live in the outbox (blob and ids), so the composer row goes.
      if (attach?.length) dropPicks(thread, attach);
      conn.sendOutgoing(m);
    } catch (err) {
      for (const file of sent ?? []) releaseUpload(file.id);
      setError(err instanceof DOMException && err.name === "QuotaExceededError"
        ? "Not enough storage on this device for these files."
        : "Can’t save offline on this device.");
    } finally {
      saving.current = false;
    }
  }

  function releasePreviews(list: Pick[]) {
    for (const pick of list) {
      if (!pick.preview) continue;
      URL.revokeObjectURL(pick.preview);
      previews.current.delete(pick.preview);
    }
  }

  function updatePick(threadId: string, id: string, patch: Partial<Pick>) {
    setPicks((prev) => {
      const list = prev[threadId];
      if (!list) return prev;
      return { ...prev, [threadId]: list.map((pick) => pick.id === id ? { ...pick, ...patch } : pick) };
    });
  }

  /**
   * Upload one picked file ahead of the send, through the shared uploader: a send queued while
   * this is still running joins the same request. Waiting files retry on reconnect or on Retry.
   */
  async function runUpload(threadId: string, pick: Pick) {
    if (uploading.current.has(pick.id) || !store.uploads) return;
    uploading.current.add(pick.id);
    try {
      updatePick(threadId, pick.id, { state: "uploading", note: undefined });
      const step = await uploadLocal(pick.id, pick.file, pick.name, pick.type);
      if (step.kind === "done") {
        updatePick(threadId, pick.id, { state: "done", uploadId: step.id, note: undefined });
      } else if (step.kind === "retry") {
        updatePick(threadId, pick.id, {
          state: "waiting",
          note: step.rateLimited ? "Too many uploads; tap Retry" : "Waiting for connection",
        });
      } else {
        updatePick(threadId, pick.id, { state: "failed", note: step.note });
        setError(step.note);
      }
    } finally {
      uploading.current.delete(pick.id);
    }
  }

  /** Picked or recorded files: limit checks first, then upload what the gateway will take. */
  function addFiles(chosen: File[], threadId: string = thread, voiceSecs?: number) {
    if (!chosen.length) return;
    const problems: string[] = [];
    const room = Math.max(0, LIMITS.maxAttachments - (picks[threadId] ?? []).length);
    const added: Pick[] = [];
    for (const file of chosen) {
      if (file.size > LIMITS.uploadBytes) {
        problems.push(`${file.name} is larger than ${formatBytes(LIMITS.uploadBytes)}.`);
        continue;
      }
      if ([...file.name].length > LIMITS.uploadNameChars) {
        problems.push(`${file.name.slice(0, 36)}… is longer than ${LIMITS.uploadNameChars} characters.`);
        continue;
      }
      if (added.length >= room) {
        problems.push(`Up to ${LIMITS.maxAttachments} files per message.`);
        break;
      }
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.add(preview);
      added.push({
        id: newId(), file, name: file.name,
        type: file.type || "application/octet-stream", size: file.size,
        state: online && store.uploads ? "uploading" : "waiting", preview,
        ...(voiceSecs === undefined ? {} : { voice: voiceSecs }),
      });
    }
    setError(problems.join(" "));
    if (!added.length) return;
    setPicks((prev) => ({ ...prev, [threadId]: [...(prev[threadId] ?? []), ...added] }));
    for (const pick of added) if (pick.state === "uploading") void runUpload(threadId, pick);
  }

  function removePick(threadId: string, id: string) {
    releasePreviews((picks[threadId] ?? []).filter((pick) => pick.id === id));
    forgetUpload(id);
    setPicks((prev) => ({
      ...prev,
      [threadId]: (prev[threadId] ?? []).filter((pick) => pick.id !== id),
    }));
  }

  function dropPicks(threadId: string, sent: Pick[]) {
    releasePreviews(sent);
    setPicks((prev) => ({
      ...prev,
      [threadId]: (prev[threadId] ?? []).filter((pick) => !sent.some((s) => s.id === pick.id)),
    }));
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp") && args === undefined && matches.length) {
      e.preventDefault();
      const i = matches.indexOf(picked!) + (e.key === "ArrowDown" ? 1 : -1);
      setSlashPick((i + matches.length) % matches.length);
      return;
    }
    if (slashOpen && e.key === "Escape") {
      e.preventDefault();
      setSlashHidden(true);
      return;
    }
    if (slash && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runSlash();
      return;
    }
    // On phones Enter makes a newline; send is the button. On desktop Enter
    // sends and Shift+Enter makes a newline.
    if (e.key === "Enter" && !e.shiftKey && FINE_POINTER) {
      e.preventDefault();
      void submit();
    }
  }

  /** Enter or send with `/…` in the composer: never a chat message. */
  function runSlash() {
    setSlashHidden(false); // an unknown name shows its hint again
    // A bare `/` only opens the list; it never runs the first command.
    if (picked && typed !== "") onRunCommand(picked, args);
  }

  return (
    <footer className="composer">
      {!sheetOpen && (error || forkError) && <p className="error-text" role="alert">{error || forkError}</p>}
      {!sheetOpen && !error && !forkError && hint && <p className="composer-hint" role="status">{hint}</p>}
      {slashOpen && <div className="slash-list" aria-label="Commands" role="group">
        {matches.map((c) => <CommandItem key={c.name} c={c} state={cmdState} active={c === picked}
          onClick={() => onRunCommand(c, args)} keepFocus />)}
        {!picked ? <p className="sheet-help" role="status">Unknown command /{typed}</p>
          : args !== undefined && <p className="slash-usage" role="status">{argsTooLong
            ? `Arguments are limited to ${LIMITS.controlArgsChars} characters.` : picked.usage}</p>}
        {!online && <p className="sheet-help">Reconnect to use commands.</p>}
      </div>}
      {archived ? (
        <p className="archived-hint">{archivedLabel(info)} · {online
          ? <button disabled={busy} onClick={onRestore}>Restore to reply</button>
          : "Reconnect to restore"}</p>
      ) : !writable ? <p className="archived-hint">Read-only until thread details are available.</p> : <>
        {files.length > 0 && <ul className="picks" aria-label={`${files.length} ${files.length === 1 ? "file" : "files"} to send`}>
          {files.map((pick) => {
            const recorded = pick.voice !== undefined;
            return (
              <li key={pick.id} className="pick" data-state={pick.state}>
                {pick.preview ? (
                  <img className="pick-thumb" src={pick.preview} alt="" />
                ) : (
                  <span className="pick-icon" aria-hidden="true">
                    <Icon d={attachmentKind(pick.type) === "image" ? IMAGE_ICON
                      : attachmentKind(pick.type) === "audio" ? AUDIO_ICON : FILE_ICON} />
                  </span>
                )}
                <span className="pick-text">
                  <b>{recorded ? "Voice note" : pick.name}</b>
                  <small title={pick.note}>{recorded
                    ? (pick.state === "done" ? lengthText(pick.voice!) : pickLabel(pick))
                    : `${pickLabel(pick)} · ${formatBytes(pick.size)}`}</small>
                </span>
                {(pick.state === "waiting" || pick.state === "failed") &&
                  <button className="pick-action" onClick={() => void runUpload(thread, pick)}>Retry</button>}
                <button className="pick-remove" aria-label={`Remove ${pick.name}`} onClick={() => removePick(thread, pick.id)}>
                  <Icon d={REMOVE_ICON} />
                </button>
                {pick.state === "uploading" && <span className="pick-progress" aria-hidden="true" />}
              </li>
            );
          })}
        </ul>}
        {recorder.voice ? (
          <div className="capsule recording" role="group" aria-label="Voice note recording">
            <button className="wrench voice-cancel" aria-label="Cancel recording" onClick={recorder.cancel}>
              <Icon d={REMOVE_ICON} />
            </button>
            <span className="voice-status">
              <i className="voice-dot" aria-hidden="true" />
              <b role="timer">{lengthText(recorder.secs)}</b>
              <small>Recording</small>
            </span>
            <button className="send voice-send" aria-label="Send voice note" data-ready=""
              onClick={() => void recorder.send()}>
              <Icon d={SEND_ICON} bold />
            </button>
          </div>
        ) : (
        <div className="capsule">
          <button ref={wrenchRef} className="wrench" aria-label="Commands" aria-haspopup="dialog"
            aria-expanded={toolsOpen}
            onClick={(e) => onTools(e.currentTarget)}>
            <Icon d={WRENCH_ICON} />
          </button>
          {store.uploads && <button className="wrench attach" aria-label="Attach files"
            onClick={() => fileRef.current?.click()}>
            <Icon d={PLUS_ICON} bold />
          </button>}
          <input ref={fileRef} type="file" multiple hidden tabIndex={-1}
            onChange={(e) => {
              const chosen = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";
              setHint("");
              addFiles(chosen);
            }} />
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            maxLength={LIMITS.sendTextChars}
            placeholder={running ? `${agentName} is working…` : `Message ${agentName}`}
            aria-label="Message"
            onChange={(e) => { setText(e.target.value); setSlashPick(0); setSlashHidden(false); }}
            onKeyDown={onKeyDown}
            enterKeyHint={FINE_POINTER ? "send" : "enter"}
          />
          {!running && canVoice && text.trim() === "" && files.length === 0 ? (
            /* Nothing to send yet, so the send slot is the mic: the 320px
               composer stays at two icons on the left. */
            <button className="send mic" aria-label="Record a voice note"
              onClick={(e) => { e.currentTarget.blur(); void recorder.start(); }}>
              <Icon d={MIC_ICON} />
            </button>
          ) : running && !slash && text.trim() === "" && files.length === 0 ? (
            /* An empty composer during a turn stops it; anything typed steers. */
            <button className="send stop" aria-label="Stop" data-ready=""
              onClick={() => { if (store.canWrite(thread)) conn.control(thread, "abort"); }}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              className="send"
              aria-label="Send"
              data-ready={(slash ? !!picked && canRun(picked, cmdState) && !argsTooLong
                : canSendFiles && (text.trim() !== "" || files.length > 0)) ? "" : undefined}
              onClick={() => void submit()}
            >
              <Icon d={SEND_ICON} bold />
            </button>
          )}
        </div>
        )}
      </>}
    </footer>
  );
}
