/**
 * The app channel's owner-question surface.
 *
 * `ask_user` hands one already-durable question to the live surface that owns the exact mapped app
 * session. Unlike Telegram there is no external send to fence: the channel's durable event log *is*
 * its delivery path, so appending one `question` event with `state: "open"` is a definite delivery.
 * Every later change of that record (answered, expired on read, cancelled by `/new`, unknown
 * delivery outcome) is another `question` event for the same id, and the app keeps the latest one.
 *
 * The projection here is deliberately pure: it reads the question document, the channel's own
 * durable log and the marks of what this channel already published, and returns the events that
 * are missing plus the marks they produce. The marks matter because the log is trimmed by
 * retention: without them a terminal state whose event was pruned would be re-published on every
 * later read. The adapter appends the events and stores the marks in the same commit that changed
 * the record, so a crash either publishes the change or leaves the record untouched for the next
 * read to reconcile.
 */
import type { Draft } from "@earendil-works/chord";
import {
  pendingQuestionViews,
  validQuestionRecord,
  type AskOptionId,
  type AskQuestionRecord,
  type AskQuestionsDocument,
  type AskQuestionView,
} from "../questions/index.js";
import type { AppDurableEvent } from "./app-protocol.js";

/** The question states protocol v2 renders; a definite non-delivery maps to no event at all. */
export type AppQuestionState = "open" | "answered" | "expired" | "cancelled" | "unknown";

/** The wire shape's fields, without the optional legacy thread and without its cursor. */
type WireQuestionEvent = Extract<AppDurableEvent, { event: "question" }>;

/** One `question` event as the adapter appends it, before its cursor is assigned. */
export type AppQuestionEventInput = Omit<WireQuestionEvent, "cursor" | "thread"> & { readonly thread: string };

/** What this channel last published for one question id; the durable log may be trimmed. */
export type AppQuestionMark = { readonly state: AppQuestionState; readonly answer?: AskOptionId };
/**
 * Marks by question id for one thread. Each thread has its own question document, so a reconcile
 * rebuilds only its own thread's map and the threads never overwrite each other's.
 */
export type AppQuestionMarks = Record<string, AppQuestionMark>;
/** Marks per thread, held in the app channel state and bounded by the question records. */
export type AppQuestionMarksByThread = Record<string, AppQuestionMarks>;

/** The latest state the app already knows per question id; later log events win over the marks. */
type KnownQuestion = AppQuestionMark;

function knownQuestions(
  events: readonly AppDurableEvent[],
  marks: AppQuestionMarks | undefined,
): Map<string, KnownQuestion> {
  const known = new Map<string, KnownQuestion>();
  for (const [id, mark] of Object.entries(marks ?? {})) known.set(id, mark);
  for (const event of events) {
    if (event.event !== "question") continue;
    known.set(event.id, {
      state: event.state,
      ...(event.answer === undefined ? {} : { answer: event.answer }),
    });
  }
  return known;
}

/** The event a record's current state projects, or `undefined` when the app should see none. */
function projectedState(record: AskQuestionRecord): AppQuestionState | undefined {
  switch (record.status) {
    case "pending":
      // `sending` is a delivery still in progress and `failed` a definite non-delivery: the app has
      // nothing to render until the record settles or the append lands.
      return record.delivery === "delivered" ? "open" : undefined;
    case "answered":
      return "answered";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    case "unknown":
      return "unknown";
    case "failed":
      return undefined;
  }
}

function questionEvent(
  thread: string,
  record: AskQuestionRecord,
  state: AppQuestionState,
): AppQuestionEventInput {
  const answer = state === "answered" ? record.optionId : undefined;
  return {
    event: "question",
    thread,
    id: record.id,
    prompt: record.question,
    options: record.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    state,
    ...(answer === undefined ? {} : { answer }),
  };
}

/** One admitted question's opening event; the durable append is the delivery. */
export function openQuestionEvent(thread: string, view: AskQuestionView): AppQuestionEventInput {
  return {
    event: "question",
    thread,
    id: view.id,
    prompt: view.question,
    options: view.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    expiresAt: new Date(view.expiresAtMs).toISOString(),
    state: "open",
  };
}

/** The mark one published event leaves; the caller stores it with the command that appended it. */
export function questionMarkOf(event: AppQuestionEventInput): AppQuestionMark {
  return event.answer === undefined
    ? { state: event.state }
    : { state: event.state, answer: event.answer };
}

/**
 * Settle overdue and crashed-delivery records (expiry on read, never a timer), then return the
 * `question` events the app's log is missing and the marks they leave. A live `open` event is proof
 * the append reached this channel, so a delivery mark lost in a crash is repaired here instead of
 * being quarantined. Records the app already shows in their current state add nothing.
 */
export function reconcileQuestionEvents(
  questions: Draft<AskQuestionsDocument>,
  events: readonly AppDurableEvent[],
  marks: AppQuestionMarks | undefined,
  thread: string,
  nowMs: number,
): { readonly events: AppQuestionEventInput[]; readonly marks: AppQuestionMarks } {
  if (!Array.isArray(questions.questions)) return { events: [], marks: {} };
  const known = knownQuestions(events, marks);
  for (const record of questions.questions) {
    if (!validQuestionRecord(record) || known.get(record.id)?.state !== "open") continue;
    if (record.status === "pending" && record.delivery === "sending") record.delivery = "delivered";
  }
  pendingQuestionViews(questions, nowMs);
  const out: AppQuestionEventInput[] = [];
  // Marks follow the records exactly: an entry exists while its record does, so the map stays bounded
  // by the question document and a pruned record can never re-publish a stale state.
  const next: AppQuestionMarks = {};
  for (const record of questions.questions) {
    if (!validQuestionRecord(record)) continue;
    const state = projectedState(record);
    if (state === undefined) continue;
    const answer = state === "answered" ? record.optionId : undefined;
    next[record.id] = answer === undefined ? { state } : { state, answer };
    const previous = known.get(record.id);
    if (previous !== undefined && previous.state === state && previous.answer === answer) continue;
    out.push(questionEvent(thread, record, state));
  }
  return { events: out, marks: next };
}
