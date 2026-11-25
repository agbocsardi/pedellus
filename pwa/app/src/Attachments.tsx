import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LIMITS, type MessageEvent } from "./protocol";
import type { Outgoing } from "./store";
import { AUDIO_ICON, FILE_ICON, IMAGE_ICON, Icon, REMOVE_ICON } from "./ui";
import { artifactUrl, attachmentKind, fileUrl, formatBytes } from "./uploads";

/** What a bubble or chip row shows; `url` is absent while a file has no id yet. */
export type AttachmentView = {
  id: string; name: string; type: string; size: number; kind: "image" | "audio" | "file" | "artifact"; url?: string;
};

const PLAY_ICON = "M8 5.5v13l11-6.5-11-6.5Z";
const PAUSE_ICON = "M9.5 5.5v13M14.5 5.5v13";
const ARTIFACT_ICON = "M4 4h16v13H4zM8 21h8M12 17v4M8 9l2 2 4-4";

/** A voice note's length, `m:ss`. */
export const lengthText = (secs: number) => {
  const whole = Math.round(secs);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};
/** A name the recorder made (`Voice note 14:32.m4a`): the label is the kind, not the timestamp. */
const VOICE_NAME = /^Voice note \d{2}:\d{2}(\.[a-z0-9]+)?$/i;
const noteLabel = (name: string) => (VOICE_NAME.test(name) ? "Voice note" : name);

/** Files on a message, or on a send that is still queued (no id yet). */
export function pendingViews(m: Outgoing): AttachmentView[] {
  return (m.pending ?? []).map((file) => ({ ...file, kind: attachmentKind(file.type) }));
}

export function messageViews(list: MessageEvent["attachments"]): AttachmentView[] {
  // Ids come from the gateway; only the protocol's shape ever becomes a URL.
  return (list ?? []).filter((file) => LIMITS.uploadIdPattern.test(file.id))
    .map((file) => ({ ...file, url: fileUrl(file.id) }));
}

export function AttachmentList({ files, onOpenArtifact, openArtifactId }: {
  files: AttachmentView[]; onOpenArtifact?: (file: AttachmentView) => void; openArtifactId?: string;
}) {
  if (!files.length) return null;
  return (
    <div className="attachments">
      {files.map((file) => {
        const key = `${file.id}-${file.name}`;
        if (!file.url) return <FileChip key={key} file={file} />;
        if (file.kind === "image") return <ImageAttachment key={key} file={file} url={file.url} />;
        if (file.kind === "audio") return <VoiceAttachment key={key} file={file} url={file.url} />;
        // An artifact is agent-made HTML/SVG; it is only ever rendered through
        // `?view=artifact` inside the sandboxed frame (protocol v2).
        if (file.kind === "artifact" && onOpenArtifact) {
          return <ArtifactCard key={key} file={file} inViewer={file.id === openArtifactId}
            onOpen={() => onOpenArtifact(file)} />;
        }
        return <FileChip key={key} file={file} />;
      })}
    </div>
  );
}

/**
 * An artifact in the chat: a still preview (never interactive — the frame takes no
 * pointer input) and the two real actions, Open and Download. The preview exists only
 * while this card is near the viewport, so an artifact scrolled past keeps no live
 * script context, and it is off entirely while this artifact's own viewer is open.
 */
function ArtifactCard({ file, onOpen, inViewer }: {
  file: AttachmentView; onOpen: () => void; inViewer?: boolean;
}) {
  const [near, setNear] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") {
      setNear(true);
      return;
    }
    // Two-way, not a latch. The margin is the same on entry and exit, and the frame's
    // height is fixed, so mounting it again never pushes the card out of the margin.
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setNear(last.isIntersecting);
    }, { rootMargin: "240px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const preview = near && !inViewer;
  return (
    <div className="artifact-card">
      <div className="artifact-frame" ref={box}>
        {preview ? <iframe className="artifact-preview" title={`${file.name} preview`}
          src={artifactUrl(file.id)} sandbox="allow-scripts" referrerPolicy="no-referrer" allow=""
          loading="lazy" tabIndex={-1} />
          : <span className="artifact-placeholder" aria-hidden="true">
            <Icon d={ARTIFACT_ICON} /><small>Preview</small>
          </span>}
      </div>
      <div className="artifact-head">
        <b className="artifact-title">{file.name}</b>
        <small className="artifact-meta">Artifact · {formatBytes(file.size)}</small>
      </div>
      <div className="artifact-actions">
        <button className="artifact-action is-primary" onClick={onOpen}>Open</button>
        <a className="artifact-action" href={fileUrl(file.id)} download={file.name}>Download</a>
      </div>
    </div>
  );
}

/**
 * Full-screen artifact view (protocol v2, Agent files and artifacts). It is a dialog,
 * not a route: nothing here is reachable from the frame, and the frame gets
 * `allow-scripts` alone, no referrer and no permissions.
 */
export function ArtifactViewer({ file, onClose }: { file: AttachmentView; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  // Focus opens on Close, never in the frame: once the artifact has focus, its own
  // document owns the keyboard (protocol v2), so this button is the guaranteed way out
  // and it stays above the frame. Escape is the dialog's own cancel event.
  useLayoutEffect(() => { close.current?.focus({ preventScroll: true }); }, []);
  return (
    <dialog ref={ref} className="artifact-layer" aria-label={`${file.name} artifact`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="artifact-view">
        <header className="artifact-view-head">
          {/* First focusable in the dialog, and above the frame in paint order. */}
          <button ref={close} className="artifact-close" onClick={onClose} aria-label="Close artifact">
            <Icon d={REMOVE_ICON} />
          </button>
          <h2 className="artifact-view-title">{file.name}</h2>
          <a className="artifact-action" href={fileUrl(file.id)} download={file.name}>Download</a>
        </header>
        <iframe className="artifact-view-frame" title={file.name} src={artifactUrl(file.id)}
          sandbox="allow-scripts" referrerPolicy="no-referrer" allow="" />
      </div>
    </dialog>
  );
}

/** Inline thumbnail; the tap opens the file itself (same-origin, cookie-authed). */
function ImageAttachment({ file, url }: { file: AttachmentView; url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <FileChip file={file} />;
  return (
    <a className="attachment-image" href={url} target="_blank" rel="noreferrer"
      aria-label={`Open ${file.name}`}>
      <img src={url} alt={file.name} loading="lazy" decoding="async" width={148} height={111}
        onError={() => setBroken(true)} />
    </a>
  );
}

/**
 * A recorded voice note: one compact row, with the browser's own `<audio>`
 * element underneath as the player. The row says what it is and how long it
 * runs; the recorder's timestamped file name stays on the download.
 */
function VoiceAttachment({ file, url }: { file: AttachmentView; url: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  if (unsupported) {
    // Not decodable here: fall back to the plain player instead of a dead button.
    return <audio className="attachment-audio" controls preload="none" src={url} aria-label={file.name} />;
  }
  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setUnsupported(true));
    else el.pause();
  };
  return (
    <div className="voice-note">
      <button className="voice-toggle" aria-label={playing ? "Pause voice note" : "Play voice note"}
        aria-pressed={playing} onClick={toggle}>
        <Icon d={playing ? PAUSE_ICON : PLAY_ICON} bold={!playing} />
      </button>
      <span className="voice-text">
        <b>{noteLabel(file.name)}</b>
        {/* Empty until the container reports a length: guessing one would be a lie. */}
        <small>{duration === null ? "" : lengthText(duration)}</small>
      </span>
      <audio ref={audio} className="voice-audio" src={url} preload="metadata" tabIndex={-1} aria-hidden="true"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)} />
    </div>
  );
}

export function FileChip({ file }: { file: AttachmentView }) {
  const body = <>
    <span className="file-chip-icon" aria-hidden="true">
      <Icon d={file.kind === "image" ? IMAGE_ICON : file.kind === "audio" ? AUDIO_ICON : FILE_ICON} />
    </span>
    <span className="file-chip-text">
      <b>{noteLabel(file.name)}</b>
      <small>{formatBytes(file.size)}</small>
    </span>
  </>;
  return file.url
    ? <a className="file-chip" href={file.url} download={file.name}>{body}</a>
    : <span className="file-chip" data-pending="">{body}</span>;
}
