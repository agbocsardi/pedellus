/**
 * Durable model-requested owner decisions (`ask_user`).
 *
 * One call admits one or more bounded questions in the calling chat's own conversation document,
 * then a live owner surface renders them: Telegram inline buttons, or plain numbered text in the
 * local terminal. The tool returns immediately and the run ends (`control.terminate`), so no
 * provider tool call is held open across a turn, a restart or an abort. The owner's answer arrives
 * later as an ordinary follow-up turn; a surface without controls (the CLI) simply lets the owner
 * type it, and a rich surface also admits the chosen option as a bounded follow-up input.
 *
 * This is deliberately not a workflow engine or a task: nothing is parked, so nothing can dangle.
 * A resolved Telegram callback claims the question and admits its answer in one commit; a replay,
 * a stale id, an expired record or a foreign chat/option is refused with fixed text. Expiry is
 * enforced when a question is read or claimed, never by a timer; the doc is the single authority.
 */
import { randomBytes } from "node:crypto";
import type { Draft } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

export const ASK_USER_TOOL_NAME = "ask_user";
/** Entry kind of the follow-up input a rich surface admits for a claimed option. */
export const ASK_ANSWER_ENTRY_KIND = "nanobot.ask-answer";
/** Telegram deep-link prefix; the payload carries opaque ids only, never a label. */
export const ASK_CALLBACK_PREFIX = "pq:";

export const ASK_USER_LIMITS = Object.freeze({
  /** One call may carry up to this many independent questions. */
  questionsPerRequest: 4,
  minOptions: 2,
  maxOptions: 4,
  questionChars: 500,
  labelChars: 60,
  descriptionChars: 200,
  /** Admitted follow-up answer text bound, including the question id. */
  answerChars: 600,
  sessionKeyChars: 200,
  /** Question records retained per conversation; pending records are never evicted. */
  retainedRecords: 24,
  /** Terminal records kept so a duplicate tap still gets "Already answered." */
  retainedTerminalMs: 30 * 60_000,
  /**
   * An admitted-but-undelivered record is quarantined as `unknown` after this grace, so a crash
   * between admission and delivery never blocks the chat forever and is never silently re-sent.
   */
  sendingGraceMs: 5 * 60_000,
  ttlSecondsDefault: 900,
  ttlSecondsMin: 30,
  ttlSecondsMax: 86_400,
  callbackDataChars: 64,
  questionIdChars: 10,
});

export const ASK_OPTION_IDS = ["a", "b", "c", "d"] as const;
export type AskOptionId = (typeof ASK_OPTION_IDS)[number];

export type AskQuestionInput = {
  readonly question: string;
  readonly options: readonly {
    readonly label: string;
    readonly description?: string;
  }[];
};

export type AskQuestionOption = {
  readonly id: AskOptionId;
  readonly label: string;
  readonly description?: string;
};

export type AskQuestionDelivery = "sending" | "delivered" | "failed" | "unknown";
export type AskQuestionStatus = "pending" | "answered" | "expired" | "cancelled" | "failed" | "unknown";

/** One durable question. Its id is opaque and is the only callback payload component besides the option id. */
export type AskQuestionRecord = {
  readonly id: string;
  /** Tool task that asked; one call's questions share it. */
  readonly taskId: number;
  readonly sessionKey: string;
  readonly question: string;
  options: AskQuestionOption[];
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  /** External delivery state; `sending` on a crash is quarantined to `unknown`. */
  delivery: AskQuestionDelivery;
  status: AskQuestionStatus;
  optionId?: AskOptionId;
  answeredAtMs?: number;
};

export type AskQuestionsDocument = { questions: AskQuestionRecord[] };

export const AskQuestionsDoc = defineDoc<AskQuestionsDocument>({
  kind: "nanobot.ask-questions",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => true,
  initial: () => ({ questions: [] }),
});

/** One rendered question as a surface may read it. No host path, credential or transcript text. */
export type AskQuestionView = {
  readonly id: string;
  readonly question: string;
  readonly options: readonly AskQuestionOption[];
  readonly expiresAtMs: number;
};

export type AskClaimResult =
  | { readonly status: "accepted"; readonly optionId: AskOptionId; readonly label: string; readonly text: string }
  | { readonly status: "replay"; readonly label?: string }
  | { readonly status: "expired" }
  | { readonly status: "cancelled" }
  | { readonly status: "stale" }
  | { readonly status: "invalid" };

export type AskClaim = { readonly result: AskClaimResult; readonly changed: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const OPTION_IDS: ReadonlySet<string> = new Set(ASK_OPTION_IDS);
const DELIVERY_STATES: ReadonlySet<string> = new Set(["sending", "delivered", "failed", "unknown"]);
const QUESTION_STATUSES: ReadonlySet<string> = new Set([
  "pending", "answered", "expired", "cancelled", "failed", "unknown",
]);

/** Credentials must never be collected through a chat question, whatever the model intends. */
const SECRET_HINTS = Object.freeze([
  "password", "passphrase", "secret", "token", "api key", "api_key", "apikey",
  "credential", "private key", "private_key",
]);

/** Strip control characters that would corrupt a rendered question, keep newlines and tabs, then bound. */
export function sanitizeAskText(value: string, maxChars: number): string {
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** True when the text appears to ask for a credential; checked before anything is delivered. */
export function containsSecretHint(text: string): boolean {
  const lowered = text.toLowerCase();
  return SECRET_HINTS.some((hint) => lowered.includes(hint));
}

/** A fresh opaque question id; 10 hex characters keeps every callback payload far below 64 bytes. */
export function newQuestionId(): string {
  return randomBytes(Math.ceil(ASK_USER_LIMITS.questionIdChars / 2)).toString("hex")
    .slice(0, ASK_USER_LIMITS.questionIdChars);
}

/** Telegram callback payload for one option; never carries the visible label. */
export function questionCallbackData(questionId: string, optionId: AskOptionId): string {
  return `${ASK_CALLBACK_PREFIX}${questionId}:${optionId}`;
}

/** Parse a Telegram callback payload; malformed or foreign data is not ours. */
export function parseQuestionCallback(data: string | undefined): { questionId: string; optionId: AskOptionId } | undefined {
  if (typeof data !== "string" || data.length > ASK_USER_LIMITS.callbackDataChars) return undefined;
  if (!data.startsWith(ASK_CALLBACK_PREFIX)) return undefined;
  const rest = data.slice(ASK_CALLBACK_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return undefined;
  const questionId = rest.slice(0, separator);
  const optionId = rest.slice(separator + 1);
  if (questionId.length !== ASK_USER_LIMITS.questionIdChars || !/^[0-9a-f]+$/.test(questionId)) return undefined;
  if (!OPTION_IDS.has(optionId)) return undefined;
  return { questionId, optionId: optionId as AskOptionId };
}

/** True when a stored record has the shape this module can act on. */
export function validQuestionRecord(value: unknown): value is AskQuestionRecord {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length !== ASK_USER_LIMITS.questionIdChars) return false;
  if (!/^[0-9a-f]+$/.test(value.id)) return false;
  if (typeof value.taskId !== "number" || !Number.isSafeInteger(value.taskId) || value.taskId < 1) return false;
  if (typeof value.sessionKey !== "string" || value.sessionKey === ""
    || value.sessionKey.length > ASK_USER_LIMITS.sessionKeyChars) return false;
  if (typeof value.question !== "string" || value.question === ""
    || value.question.length > ASK_USER_LIMITS.questionChars) return false;
  if (typeof value.createdAtMs !== "number" || !Number.isFinite(value.createdAtMs)) return false;
  if (typeof value.expiresAtMs !== "number" || !Number.isFinite(value.expiresAtMs)) return false;
  if (typeof value.delivery !== "string" || !DELIVERY_STATES.has(value.delivery)) return false;
  if (typeof value.status !== "string" || !QUESTION_STATUSES.has(value.status)) return false;
  if (value.optionId !== undefined && !OPTION_IDS.has(value.optionId as string)) return false;
  if (value.answeredAtMs !== undefined
    && (typeof value.answeredAtMs !== "number" || !Number.isFinite(value.answeredAtMs))) return false;
  if (!Array.isArray(value.options) || value.options.length < ASK_USER_LIMITS.minOptions
    || value.options.length > ASK_USER_LIMITS.maxOptions) return false;
  const ids = new Set<string>();
  for (const option of value.options) {
    if (!isRecord(option)) return false;
    if (typeof option.id !== "string" || !OPTION_IDS.has(option.id) || ids.has(option.id)) return false;
    ids.add(option.id);
    if (typeof option.label !== "string" || option.label === ""
      || option.label.length > ASK_USER_LIMITS.labelChars) return false;
    if (option.description !== undefined
      && (typeof option.description !== "string" || option.description.length > ASK_USER_LIMITS.descriptionChars)) {
      return false;
    }
  }
  return true;
}

/** True when a surface view has the exact bounded shape a terminal or channel may render. */
export function validAskQuestionView(value: unknown): value is AskQuestionView {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length !== ASK_USER_LIMITS.questionIdChars
    || !/^[0-9a-f]+$/.test(value.id)) return false;
  if (typeof value.question !== "string" || value.question === ""
    || value.question.length > ASK_USER_LIMITS.questionChars) return false;
  if (typeof value.expiresAtMs !== "number" || !Number.isFinite(value.expiresAtMs)) return false;
  if (!Array.isArray(value.options) || value.options.length < ASK_USER_LIMITS.minOptions
    || value.options.length > ASK_USER_LIMITS.maxOptions) return false;
  return value.options.every((option) => isRecord(option)
    && typeof option.id === "string" && OPTION_IDS.has(option.id)
    && typeof option.label === "string" && option.label !== ""
    && option.label.length <= ASK_USER_LIMITS.labelChars
    && (option.description === undefined || (typeof option.description === "string"
      && option.description.length <= ASK_USER_LIMITS.descriptionChars)));
}

export type AskInputResult =
  | {
    readonly ok: true;
    readonly questions: readonly AskQuestionInput[];
    readonly ttlSeconds: number;
  }
  | { readonly ok: false; readonly reason: string };

/** Normalize and bound one model call's arguments; the tool schema already validated their shape. */
export function normalizeAskInput(rawQuestions: unknown, rawTtl: unknown): AskInputResult {
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1
    || rawQuestions.length > ASK_USER_LIMITS.questionsPerRequest) {
    return { ok: false, reason: `Between 1 and ${ASK_USER_LIMITS.questionsPerRequest} questions are allowed.` };
  }
  const questions: AskQuestionInput[] = [];
  for (const raw of rawQuestions) {
    if (!isRecord(raw)) return { ok: false, reason: "Each question must be an object." };
    const question = typeof raw.question === "string" ? sanitizeAskText(raw.question, ASK_USER_LIMITS.questionChars) : "";
    if (question === "") return { ok: false, reason: "Each question needs non-empty text." };
    const rawOptions = raw.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < ASK_USER_LIMITS.minOptions
      || rawOptions.length > ASK_USER_LIMITS.maxOptions) {
      return {
        ok: false,
        reason: `Each question needs between ${ASK_USER_LIMITS.minOptions} and ${ASK_USER_LIMITS.maxOptions} options.`,
      };
    }
    const labels = new Set<string>();
    const options: { label: string; description?: string }[] = [];
    for (const rawOption of rawOptions) {
      if (!isRecord(rawOption)) return { ok: false, reason: "Each option must be an object with a label." };
      const label = typeof rawOption.label === "string"
        ? sanitizeAskText(rawOption.label, ASK_USER_LIMITS.labelChars) : "";
      if (label === "") return { ok: false, reason: "Every option needs a non-empty label." };
      if (labels.has(label)) return { ok: false, reason: "Option labels must be unique within a question." };
      labels.add(label);
      const description = typeof rawOption.description === "string"
        ? sanitizeAskText(rawOption.description, ASK_USER_LIMITS.descriptionChars) : undefined;
      options.push(description === undefined || description === "" ? { label } : { label, description });
    }
    if (containsSecretHint(question) || options.some((option) =>
      containsSecretHint(option.label) || containsSecretHint(option.description ?? ""))) {
      return {
        ok: false,
        reason: "This question appears to collect a credential or secret. Ask for those outside the chat.",
      };
    }
    questions.push({ question, options });
  }
  let ttlSeconds: number = ASK_USER_LIMITS.ttlSecondsDefault;
  if (rawTtl !== undefined) {
    if (typeof rawTtl !== "number" || !Number.isInteger(rawTtl)
      || rawTtl < ASK_USER_LIMITS.ttlSecondsMin || rawTtl > ASK_USER_LIMITS.ttlSecondsMax) {
      return {
        ok: false,
        reason: `expiresInSeconds must be an integer from ${ASK_USER_LIMITS.ttlSecondsMin} to ${ASK_USER_LIMITS.ttlSecondsMax}.`,
      };
    }
    ttlSeconds = rawTtl;
  }
  return { ok: true, questions, ttlSeconds };
}

/** Build the durable records for one admitted call; ids are opaque and stable within the call. */
export function buildQuestionRecords(input: {
  readonly questions: readonly AskQuestionInput[];
  readonly sessionKey: string;
  readonly taskId: number;
  readonly nowMs: number;
  readonly ttlSeconds: number;
  readonly idFor?: () => string;
}): AskQuestionRecord[] {
  const idFor = input.idFor ?? newQuestionId;
  const used = new Set<string>();
  return input.questions.map((question) => {
    let id = idFor();
    if (!/^[0-9a-f]+$/.test(id) || id.length !== ASK_USER_LIMITS.questionIdChars) {
      throw new Error("question id generator produced an invalid id");
    }
    while (used.has(id)) id = idFor();
    used.add(id);
    return {
      id,
      taskId: input.taskId,
      sessionKey: input.sessionKey,
      question: question.question,
      options: question.options.map((option, index) => ({
        id: ASK_OPTION_IDS[index]!,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
      createdAtMs: input.nowMs,
      expiresAtMs: input.nowMs + input.ttlSeconds * 1000,
      delivery: "sending" as const,
      status: "pending" as const,
    };
  });
}

/** Settle overdue and crashed-delivery records in place; returns true when anything changed. */
function expireQuestions(questions: Draft<AskQuestionRecord>[], nowMs: number): boolean {
  let changed = false;
  for (const question of questions) {
    if (question.status !== "pending") continue;
    if (nowMs > question.expiresAtMs) {
      question.status = "expired";
      changed = true;
      continue;
    }
    if (question.delivery === "sending" && nowMs - question.createdAtMs >= ASK_USER_LIMITS.sendingGraceMs) {
      question.status = "unknown";
      question.delivery = "unknown";
      changed = true;
    }
  }
  return changed;
}

/** Drop malformed and stale terminal records, never a pending one; keeps the document bounded. */
function pruneQuestions(questions: Draft<AskQuestionRecord>[], nowMs: number): void {
  for (let index = questions.length - 1; index >= 0; index--) {
    const question = questions[index]!;
    if (!validQuestionRecord(question)) {
      questions.splice(index, 1);
      continue;
    }
    if (question.status === "pending" || question.status === "unknown") continue;
    const settledAt = question.answeredAtMs ?? question.expiresAtMs;
    if (nowMs - settledAt >= ASK_USER_LIMITS.retainedTerminalMs) questions.splice(index, 1);
  }
  if (questions.length <= ASK_USER_LIMITS.retainedRecords) return;
  const excess = questions.length - ASK_USER_LIMITS.retainedRecords;
  let removed = 0;
  for (let index = 0; index < questions.length && removed < excess;) {
    if (questions[index]!.status === "pending" || questions[index]!.status === "unknown") {
      index += 1;
      continue;
    }
    questions.splice(index, 1);
    removed += 1;
  }
}

/**
 * Admit one call's questions. A conversation with an outstanding question refuses a new call, so
 * two answers can never race for the same chat; terminal records are pruned first.
 */
export function admitQuestionRecords(
  doc: Draft<AskQuestionsDocument>,
  records: readonly AskQuestionRecord[],
  nowMs: number,
): "admitted" | "pending" | "invalid" {
  if (!Array.isArray(doc.questions)) return "invalid";
  if (records.some((record) => !validQuestionRecord(record))) return "invalid";
  expireQuestions(doc.questions, nowMs);
  if (doc.questions.some((question) => question.status === "pending")) return "pending";
  pruneQuestions(doc.questions, nowMs);
  if (doc.questions.length + records.length > ASK_USER_LIMITS.retainedRecords) return "invalid";
  for (const record of records) {
    if (doc.questions.some((question) => question.id === record.id)) return "invalid";
    doc.questions.push(record as Draft<AskQuestionRecord>);
  }
  return "admitted";
}

/** Mark a question's external delivery; an already-settled question is left untouched. */
export function markQuestionDelivered(doc: Draft<AskQuestionsDocument>, ids: readonly string[]): void {
  if (!Array.isArray(doc.questions)) return;
  const wanted = new Set(ids);
  for (const question of doc.questions) {
    if (!wanted.has(question.id) || question.status !== "pending") continue;
    question.delivery = "delivered";
  }
}

/** A delivery that did not complete: terminal and never re-sent, so nothing waits for an answer. */
export function markQuestionDeliveryFailed(doc: Draft<AskQuestionsDocument>, ids: readonly string[]): void {
  if (!Array.isArray(doc.questions)) return;
  const wanted = new Set(ids);
  for (const question of doc.questions) {
    if (!wanted.has(question.id) || question.status !== "pending") continue;
    question.delivery = "failed";
    question.status = "failed";
  }
}

/** An ambiguous send is quarantined, retained, and never retried or reported as definite failure. */
export function markQuestionDeliveryUnknown(doc: Draft<AskQuestionsDocument>, id: string): void {
  const record = doc.questions.find((question) => question.id === id && question.status === "pending");
  if (record === undefined) return;
  record.status = "unknown";
  record.delivery = "unknown";
}

/** The next ordinary text input answers the oldest delivered question in this exact session.
 * Hosts call this inside the same commit as admitting that input; no answer text is duplicated here.
 */
export function claimTypedQuestionAnswer(
  doc: Draft<AskQuestionsDocument>, sessionKey: string, text: string, nowMs: number,
): string | undefined {
  if (!Array.isArray(doc.questions) || text.trim() === "") return undefined;
  expireQuestions(doc.questions, nowMs);
  const record = doc.questions.find((question) => validQuestionRecord(question)
    && question.sessionKey === sessionKey && question.status === "pending" && question.delivery === "delivered");
  if (record === undefined) return undefined;
  record.status = "answered";
  record.answeredAtMs = nowMs;
  return record.id;
}

/** Pending question views for one attach or call, expiring overdue records in place. */
export function pendingQuestionViews(
  doc: Draft<AskQuestionsDocument>,
  nowMs: number,
): { readonly views: AskQuestionView[]; readonly changed: boolean } {
  if (!Array.isArray(doc.questions)) return { views: [], changed: false };
  const changed = expireQuestions(doc.questions, nowMs);
  const views = doc.questions
    .filter((question) => validQuestionRecord(question) && question.status === "pending")
    .map(questionView);
  return { views, changed };
}

/** One record's surface view; drops nothing the surface needs and adds no host-only field. */
export function questionView(record: AskQuestionRecord): AskQuestionView {
  return {
    id: record.id,
    question: record.question,
    options: record.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    expiresAtMs: record.expiresAtMs,
  };
}

/** The follow-up input a claimed option admits; fixed shape, bounded by the record's own labels. */
export function questionAnswerText(record: AskQuestionRecord, option: AskQuestionOption): string {
  return sanitizeAskText(`Answered question ${record.id}: ${option.label}`, ASK_USER_LIMITS.answerChars);
}

/**
 * Claim one answer in the durable record. Status, expiry, session, and option are checked in that
 * order, so a duplicate tap, a stale id, an expired question and a foreign option each get one
 * fixed outcome and the record changes at most once.
 */
export function claimQuestionAnswer(
  doc: Draft<AskQuestionsDocument>,
  input: {
    readonly questionId: string;
    readonly optionId: string;
    readonly sessionKey: string;
    readonly nowMs: number;
  },
): AskClaim {
  if (!Array.isArray(doc.questions)) return { result: { status: "stale" }, changed: false };
  const changed = expireQuestions(doc.questions, input.nowMs);
  const record = doc.questions.find((question) =>
    validQuestionRecord(question) && question.id === input.questionId);
  if (record === undefined || !validQuestionRecord(record)) return { result: { status: "stale" }, changed };
  if (record.sessionKey !== input.sessionKey) return { result: { status: "stale" }, changed };
  if (record.status === "answered") {
    const previous = record.optionId === undefined ? undefined : optionLabel(record, record.optionId);
    return { result: { status: "replay", ...(previous === undefined ? {} : { label: previous }) }, changed };
  }
  if (record.status === "expired") return { result: { status: "expired" }, changed };
  if (record.status === "cancelled") return { result: { status: "cancelled" }, changed };
  if (record.status !== "pending") return { result: { status: "stale" }, changed };
  if (input.nowMs > record.expiresAtMs) {
    record.status = "expired";
    return { result: { status: "expired" }, changed: true };
  }
  if (!OPTION_IDS.has(input.optionId)) return { result: { status: "invalid" }, changed };
  const option = record.options.find((candidate) => candidate.id === input.optionId);
  if (option === undefined) return { result: { status: "invalid" }, changed };
  record.optionId = option.id;
  record.status = "answered";
  record.answeredAtMs = input.nowMs;
  return {
    result: {
      status: "accepted",
      optionId: option.id,
      label: option.label,
      text: questionAnswerText(record, option),
    },
    changed: true,
  };
}

/** Withdraw every outstanding question in one conversation, for example on `/new`. */
export function cancelPendingQuestions(doc: Draft<AskQuestionsDocument>): number {
  if (!Array.isArray(doc.questions)) return 0;
  let cancelled = 0;
  for (const question of doc.questions) {
    if (question.status !== "pending") continue;
    question.status = "cancelled";
    cancelled += 1;
  }
  return cancelled;
}

function optionLabel(record: AskQuestionRecord, optionId: AskOptionId): string | undefined {
  return record.options.find((option) => option.id === optionId)?.label;
}

/** Fixed acknowledgement text for a Telegram callback or a local refusal; never model or channel text. */
export function claimOutcomeText(result: AskClaimResult): string {
  switch (result.status) {
    case "accepted":
      return `Answered: ${result.label}`;
    case "replay":
      return "Already answered.";
    case "expired":
      return "This question expired without an answer.";
    case "cancelled":
      return "This question was cancelled.";
    case "stale":
      return "This question is no longer open.";
    case "invalid":
      return "That option is not part of this question.";
  }
}

/**
 * Render one question as bounded plain text for a surface. Option labels are model text: Telegram
 * sends this without a parse mode, and the CLI prints it literally, so it can never become markup.
 */
export function renderQuestionText(
  view: AskQuestionView,
  surface: "telegram" | "cli",
  nowMs: number,
): string {
  const remainingMinutes = Math.max(1, Math.round((view.expiresAtMs - nowMs) / 60_000));
  const lines = [
    `[Question ${view.id}]`,
    view.question,
    "",
    ...view.options.map((option, index) =>
      `${index + 1}. ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`),
    "",
    surface === "telegram"
      ? "Tap one option, or reply with your own answer."
      : "Reply with an option number, or type your own answer.",
    `Answerable for about ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}; an expired or ` +
      "already answered question is refused.",
  ];
  return sanitizeAskText(lines.join("\n"), 3_500);
}
