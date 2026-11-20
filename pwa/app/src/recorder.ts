import { LIMITS } from "./protocol";

/** A voice note stops at five minutes; longer is a file transfer, not a message. */
export const VOICE_MAX_MS = 5 * 60_000;

/** iOS Safari records only `audio/mp4`; Chromium browsers prefer Opus in WebM. */
const PREFERRED_TYPES = ["audio/mp4", "audio/webm;codecs=opus"] as const;

/** Whether this browser and context can capture audio at all (the composer hides the mic otherwise). */
export function canRecord(): boolean {
  return typeof MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

/** The first supported container, or `""` to let the browser choose its default. */
function recorderType(): string {
  for (const type of PREFERRED_TYPES) if (MediaRecorder.isTypeSupported(type)) return type;
  return "";
}

/** A stable extension per container, so what the app sent is what the gateway serves. */
function extension(type: string): string {
  if (/mp4|m4a|aac/.test(type)) return "m4a";
  if (/webm/.test(type)) return "webm";
  if (/ogg|opus/.test(type)) return "ogg";
  if (/wav/.test(type)) return "wav";
  if (/mpeg|mp3/.test(type)) return "mp3";
  return "audio";
}

const NOTE_TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** `Voice note 14:32.m4a`: bounded like any upload name, and metadata only, never a path. */
export function voiceNoteName(type: string, at: number): string {
  return `Voice note ${NOTE_TIME.format(at)}.${extension(type)}`.slice(0, LIMITS.uploadNameChars);
}

/** Why a recording ended on its own, if it did. */
export type VoiceStop = "cap" | "size" | null;
export type VoiceNote = { file: File; stopped: VoiceStop };

export type Recording = {
  /** Stop and hand back the audio; `undefined` after a cancel or when nothing was captured. */
  finish(): Promise<VoiceNote | undefined>;
  /** Discard the recording and let the microphone go. */
  cancel(): void;
};

/**
 * Capture one voice note. The caller asks for the microphone on a tap, not at
 * load, and owns the five-minute cap; the size cap sits here because only the
 * recorder sees the byte count. Every path stops the stream's tracks, which is
 * what turns the microphone indicator off.
 */
export async function startVoiceNote(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const preferred = recorderType();
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    throw err;
  }
  const startedAt = Date.now();
  const chunks: Blob[] = [];
  let bytes = 0;
  let stopped: VoiceStop = null;
  let cancelled = false;
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const end = () => {
    for (const track of stream.getTracks()) track.stop();
    release();
  };
  rec.ondataavailable = (ev) => {
    if (!ev.data.size) return;
    chunks.push(ev.data);
    bytes += ev.data.size;
    // Never hand over a file the gateway would have to refuse.
    if (bytes > LIMITS.uploadBytes && rec.state !== "inactive") {
      stopped = "size";
      rec.stop();
    }
  };
  rec.onstop = end;
  rec.onerror = end;
  rec.start();
  return {
    async finish() {
      if (rec.state !== "inactive") {
        try { rec.stop(); } catch { /* the browser already stopped it */ }
      }
      // A suspended or killed recorder can swallow `onstop`; the microphone
      // must not stay on because of it.
      const guard = setTimeout(end, 2_000);
      await done;
      clearTimeout(guard);
      if (cancelled || !chunks.length) return undefined;
      const type = rec.mimeType || preferred || "audio/webm";
      const file = new File([new Blob(chunks, { type })], voiceNoteName(type, startedAt), { type });
      return { file, stopped: stopped ?? (bytes > LIMITS.uploadBytes ? "size" : null) };
    },
    cancel() {
      cancelled = true;
      if (rec.state !== "inactive") {
        try { rec.stop(); } catch { /* the browser already stopped it */ }
      }
      end();
    },
  };
}
