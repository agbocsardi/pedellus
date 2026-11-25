import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { LIMITS } from "./protocol";
import { startVoiceNote, VOICE_MAX_MS, type Recording } from "./recorder";
import type { Store } from "./store";
import { formatBytes } from "./uploads";

/**
 * One voice note's lifecycle in the composer: the permission prompt on the mic tap (never at
 * load), the running clock, a screen wake lock, the five-minute cap, and an honest end whenever
 * the composer can no longer show the recording (background, thread switch, read-only, unmount).
 *
 * `queue` sends a finished note through the normal upload/queue path; `keep` turns a note that had
 * to stop into a composer chip instead of dropping it.
 */
export function useVoiceRecorder({ store, thread, writable, busy, queue, keep, setError, setHint }: {
  store: Store;
  thread: string;
  writable: boolean;
  /** A send is being saved right now; taking the recorder would lose the audio. */
  busy: () => boolean;
  queue: (file: File) => Promise<void>;
  keep: (file: File, thread: string, secs?: number) => void;
  setError: (message: string) => void;
  setHint: (message: string) => void;
}) {
  /** A voice note being recorded, and the thread it belongs to. */
  const [voice, setVoice] = useState<{ startedAt: number; thread: string } | null>(null);
  const [secs, setSecs] = useState(0);
  const voiceRef = useRef<{ recording: Recording; cap: ReturnType<typeof setTimeout>; startedAt: number } | null>(null);
  /** Set before the permission prompt resolves, so a second tap cannot start a second stream. */
  const starting = useRef(false);
  /** False once the composer has gone; a late permission answer must not arm a recording. */
  const mounted = useRef(true);

  /** Mic tap: the permission prompt happens here, never at load. */
  async function start() {
    // Synchronous guards only: iOS needs `getUserMedia` called in the tap
    // handler itself, and two taps must never open two streams.
    if (starting.current || voiceRef.current || !store.canWrite(thread)) return;
    starting.current = true;
    setError("");
    setHint("");
    let recording: Recording;
    try {
      recording = await startVoiceNote();
    } catch (err) {
      starting.current = false;
      setError(err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")
        ? "Microphone access was denied. Allow it for this app to record a voice note."
        : "Could not start recording on this device.");
      return;
    }
    // The screen, the thread or its write access may have gone behind the
    // permission prompt: nobody could stop this recording, so let it go now.
    if (!mounted.current || store.openThread !== thread || !store.canWrite(thread)) {
      starting.current = false;
      recording.cancel();
      return;
    }
    starting.current = false;
    const startedAt = Date.now();
    const cap = setTimeout(() => void sendLatest.current(true), VOICE_MAX_MS);
    voiceRef.current = { recording, cap, startedAt };
    setVoice({ startedAt, thread });
    setSecs(0);
  }

  /** Take the recorder down once; the caller decides what becomes of the audio. */
  async function take() {
    const current = voiceRef.current;
    if (!current) return undefined;
    voiceRef.current = null;
    clearTimeout(current.cap);
    setVoice(null);
    return current.recording.finish();
  }

  /** Stop and send: one file, through the same upload and queue as a picked attachment. */
  async function send(fromCap = false) {
    if (!voiceRef.current) return;
    // Taking the recorder destroys its audio, so refuse before that when the
    // send could only be dropped; the row keeps the recording instead.
    if (busy() || !store.canWrite(thread)) {
      if (!fromCap) {
        setHint("Couldn’t send the voice note; it is still recording.");
        return;
      }
      // The five-minute cap fired: stop here and keep the audio, never record
      // past the cap because a send was refused.
      void stopAndKeep(thread, "Recording stopped at 5 minutes and was kept.");
      return;
    }
    const result = await take();
    if (!result) {
      setHint("Nothing was recorded.");
      return;
    }
    if (result.stopped === "size") {
      setHint(`Recording stopped at ${formatBytes(LIMITS.uploadBytes)} and was discarded.`);
      return;
    }
    await queue(result.file);
    if (result.stopped === "cap") setHint("Recording stopped at 5 minutes and was sent.");
  }
  // The cap timer outlives the render that armed it; it always sends through the latest one.
  const sendLatest = useRef(send);
  useLayoutEffect(() => { sendLatest.current = send; });

  function cancel() {
    const current = voiceRef.current;
    if (!current) return;
    voiceRef.current = null;
    clearTimeout(current.cap);
    setVoice(null);
    current.recording.cancel();
  }

  /** The composer can no longer show this recording: stop it and keep what it captured. */
  async function stopAndKeep(threadId: string, why: string) {
    // Read the clock before `take` drops the ref: the chip shows this length.
    const started = voiceRef.current?.startedAt;
    const length = started === undefined ? undefined : Math.round((Date.now() - started) / 1000);
    const result = await take();
    if (!result) return;
    if (result.stopped === "size") {
      setHint(`Recording stopped at ${formatBytes(LIMITS.uploadBytes)} and was discarded.`);
      return;
    }
    setHint(why);
    keep(result.file, threadId, length);
  }

  // The elapsed time of a running recording; the five-minute cap is its own timer.
  useEffect(() => {
    if (!voice) return;
    const tick = () => setSecs(Math.floor((Date.now() - voice.startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [voice]);
  // Auto-lock would background the app and end the note: keep the screen on
  // while recording. Unsupported or refused, it simply locks as before.
  useEffect(() => {
    if (!voice || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    let done = false;
    navigator.wakeLock.request("screen").then((l) => { if (done) void l.release(); else lock = l; }, () => {});
    return () => { done = true; void lock?.release(); };
  }, [voice]);
  // iOS suspends media in a backgrounded app, and a recorder that no longer
  // records is a lie: end the note honestly and keep what it captured.
  const end = useEffectEvent((threadId: string, why: string) => { void stopAndKeep(threadId, why); });
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && voice) end(voice.thread, "Recording stopped when the app went to the background.");
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [voice]);
  // A thread that turns read-only mid-recording takes the recording row with
  // it, so end the note here with the same honest "keep" path as the rest.
  useEffect(() => {
    if (voice && voice.thread === thread && !writable) end(voice.thread, "Recording stopped when the thread became read-only.");
  }, [voice, thread, writable]);
  // The recording row belongs to the thread it was started in.
  useEffect(() => {
    if (voice && voice.thread !== thread) end(voice.thread, "Recording stopped when you left the thread.");
  }, [voice, thread]);
  // Leaving the composer ends the note and lets the microphone go; a permission
  // prompt still open must not be answered with a recording nobody can see.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      starting.current = false;
      const current = voiceRef.current;
      voiceRef.current = null;
      if (current) {
        clearTimeout(current.cap);
        current.recording.cancel();
      }
    };
  }, []);

  return { voice, secs, start, send: () => send(), cancel };
}
