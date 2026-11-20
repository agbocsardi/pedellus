/**
 * The app channel's owner-question surface.
 *
 * `ask_user` hands one already-durable question to the live surface that owns the exact mapped app
 * session. Unlike Telegram there is no external send to fence: the channel's durable event log *is*
 * its delivery path, so appending one `question` event with `state: "open"` is a definite delivery.
 * Every later change of that record (answered, expired on read, cancelled by `/new`, unknown
 * delivery outcome) is another `question` event for the same id, and the app keeps the latest one.
 *
 * The projection here is deliberately pure: it reads the question document and the channel's own
 * durable log and returns the events that are missing. The adapter appends them in the same commit
 * that changed the record, so a crash either publishes the change or leaves the record untouched
 * for the next read to reconcile.
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

/** The latest state the app already knows per question id; the log is ordered by cursor. */
type KnownQuestion = { readonly state: AppQuestionState; readonly answer?: AskOptionId };

function knownQuestions(events: readonly AppDurableEvent[]): Map<string, KnownQuestion> {
  const known = new Map<string, KnownQuestion>();
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

/**
 * Settle overdue and crashed-delivery records (expiry on read, never a timer), then return the
 * `question` events the app's log is missing. A live `open` event is proof the append reached this
 * channel, so a delivery mark lost in a crash is upgraded here instead of being quarantined as an
 * unknown outcome. Records the app already shows in their current state add nothing.
 */
export function reconcileQuestionEvents(
  questions: Draft<AskQuestionsDocument>,
  events: readonly AppDurableEvent[],
  thread: string,
  nowMs: number,
): AppQuestionEventInput[] {
  if (!Array.isArray(questions.questions)) return [];
  const known = knownQuestions(events);
  for (const record of questions.questions) {
    if (record.status === "pending" && record.delivery === "sending" && known.get(record.id)?.state === "open") {
      record.delivery = "delivered";
    }
  }
  pendingQuestionViews(questions, nowMs);
  const out: AppQuestionEventInput[] = [];
  for (const record of questions.questions) {
    if (!validQuestionRecord(record)) continue;
    const state = projectedState(record);
    if (state === undefined) continue;
    const previous = known.get(record.id);
    const answer = state === "answered" ? record.optionId : undefined;
    if (previous !== undefined && previous.state === state && previous.answer === answer) continue;
    out.push(questionEvent(thread, record, state));
  }
  return out;
}
