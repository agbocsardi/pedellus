// ask_user durable question records: bounded admission, single-use claims, expiry, replay and
// callback payload rules. No gateway, provider, clock or network: every transition is pure and
// takes the caller's `nowMs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  ASK_USER_LIMITS,
  admitQuestionRecords,
  buildQuestionRecords,
  cancelPendingQuestions,
  claimOutcomeText,
  claimQuestionAnswer,
  claimTypedQuestionAnswer,
  markQuestionDelivered,
  markQuestionDeliveryUnknown,
  normalizeAskInput,
  parseQuestionCallback,
  pendingQuestionViews,
  questionCallbackData,
  renderQuestionText,
  validAskQuestionView,
} = await import(new URL('../dist/questions/index.js', import.meta.url).href);

const T0 = 1_800_000_000_000;

function store() {
  return { questions: [] };
}

function ask(overrides = {}) {
  const normalized = normalizeAskInput([{
    question: 'Deploy now?',
    options: [{ label: 'Yes' }, { label: 'No', description: 'stay on the current build' }],
  }], undefined);
  assert.equal(normalized.ok, true);
  let index = 0;
  return buildQuestionRecords({
    questions: normalized.questions,
    sessionKey: 'telegram:7:chat:501',
    taskId: 42,
    nowMs: T0,
    ttlSeconds: normalized.ttlSeconds,
    idFor: () => (index++ === 0 ? 'aaaaaaaaaa' : 'bbbbbbbbbb'),
    ...overrides,
  });
}

test('one call admits bounded questions and a second call is refused while one is pending', () => {
  const doc = store();
  const records = ask();
  assert.equal(admitQuestionRecords(doc, records, T0), 'admitted');
  assert.equal(doc.questions.length, 1);
  assert.equal(doc.questions[0].status, 'pending');
  assert.deepEqual(doc.questions[0].options.map((option) => option.id), ['a', 'b']);

  const second = buildQuestionRecords({
    questions: ask().map((record) => ({ question: record.question, options: record.options })),
    sessionKey: 'telegram:7:chat:501',
    taskId: 43,
    nowMs: T0 + 1_000,
    ttlSeconds: 900,
    idFor: () => 'ffffffffff',
  });
  assert.equal(admitQuestionRecords(doc, second, T0 + 1_000), 'pending');
  assert.equal(doc.questions.length, 1);
});

test('normalization refuses malformed, duplicated, secret-seeking and unbounded input', () => {
  assert.equal(normalizeAskInput([], undefined).ok, false);
  assert.equal(normalizeAskInput([{ question: 'Pick', options: [{ label: 'Only' }] }], undefined).ok, false);
  assert.equal(normalizeAskInput([{
    question: 'Pick', options: [{ label: 'Same' }, { label: 'Same' }],
  }], undefined).ok, false);
  assert.equal(normalizeAskInput([{
    question: 'Paste your API key', options: [{ label: 'Sure' }, { label: 'No' }],
  }], undefined).ok, false);
  assert.equal(normalizeAskInput([{
    question: 'Pick', options: [{ label: 'Yes' }, { label: 'No' }],
  }], 1).ok, false);
  const normalized = normalizeAskInput([{
    question: 'Pick', options: [{ label: 'Yes' }, { label: 'No' }],
  }], 30);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.ttlSeconds, 30);
});

test('one option is claimed exactly once and replay, expiry, foreign session and unknown options are fixed outcomes', () => {
  const doc = store();
  const [record] = ask();
  assert.equal(admitQuestionRecords(doc, [record], T0), 'admitted');

  const foreign = claimQuestionAnswer(doc, {
    questionId: record.id, optionId: 'a', sessionKey: 'telegram:7:chat:999', nowMs: T0 + 1,
  });
  assert.equal(foreign.result.status, 'stale');
  assert.equal(doc.questions[0].status, 'pending');

  const invalid = claimQuestionAnswer(doc, {
    questionId: record.id, optionId: 'z', sessionKey: 'telegram:7:chat:501', nowMs: T0 + 1,
  });
  assert.equal(invalid.result.status, 'invalid');

  const accepted = claimQuestionAnswer(doc, {
    questionId: record.id, optionId: 'b', sessionKey: 'telegram:7:chat:501', nowMs: T0 + 2,
  });
  assert.equal(accepted.result.status, 'accepted');
  assert.equal(accepted.result.label, 'No');
  assert.equal(accepted.result.text, `Answered question ${record.id}: No`);
  assert.equal(doc.questions[0].status, 'answered');
  assert.equal(doc.questions[0].optionId, 'b');

  const replay = claimQuestionAnswer(doc, {
    questionId: record.id, optionId: 'a', sessionKey: 'telegram:7:chat:501', nowMs: T0 + 3,
  });
  assert.equal(replay.result.status, 'replay');
  assert.equal(replay.result.label, 'No');
  assert.equal(claimOutcomeText(replay.result), 'Already answered.');

  const [expiring] = buildQuestionRecords({
    questions: [{ question: 'Still there?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    sessionKey: 'telegram:7:chat:501',
    taskId: 44,
    nowMs: T0,
    ttlSeconds: 60,
    idFor: () => 'abcdef1234',
  });
  assert.equal(admitQuestionRecords(doc, [expiring], T0 + 10), 'admitted');
  const expired = claimQuestionAnswer(doc, {
    questionId: expiring.id, optionId: 'a', sessionKey: 'telegram:7:chat:501', nowMs: T0 + 61_000,
  });
  assert.equal(expired.result.status, 'expired');
  assert.equal(claimOutcomeText(expired.result), 'This question expired without an answer.');
});

test('pending views expire overdue questions and /new cancels the rest', () => {
  const doc = store();
  const [record] = ask();
  assert.equal(admitQuestionRecords(doc, [record], T0), 'admitted');
  const live = pendingQuestionViews(doc, T0 + 60_000);
  assert.equal(live.views.length, 1);
  assert.equal(live.views[0].id, record.id);
  assert.equal(validAskQuestionView(live.views[0]), true);
  assert.equal(renderQuestionText(live.views[0], 'cli', T0 + 60_000).includes('Reply with an option number'), true);

  const overdue = pendingQuestionViews(doc, T0 + 900_001);
  assert.equal(overdue.views.length, 0);
  assert.equal(doc.questions[0].status, 'expired');

  const [next] = buildQuestionRecords({
    questions: [{ question: 'Again?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    sessionKey: 'telegram:7:chat:501',
    taskId: 45,
    nowMs: T0 + 900_002,
    ttlSeconds: 900,
    idFor: () => '00112233aa',
  });
  assert.equal(admitQuestionRecords(doc, [next], T0 + 900_002), 'admitted');
  assert.equal(cancelPendingQuestions(doc), 1);
  assert.equal(doc.questions.find((entry) => entry.id === next.id).status, 'cancelled');
  assert.equal(claimOutcomeText(claimQuestionAnswer(doc, {
    questionId: next.id, optionId: 'a', sessionKey: 'telegram:7:chat:501', nowMs: T0 + 900_003,
  }).result), 'This question was cancelled.');
});

test('typed answers claim only delivered questions in their session and unknown outcomes are retained', () => {
  const doc = store();
  const [record] = ask();
  admitQuestionRecords(doc, [record], T0);
  assert.equal(claimTypedQuestionAnswer(doc, record.sessionKey, 'yes', T0 + 1), undefined);
  markQuestionDelivered(doc, [record.id]);
  assert.equal(claimTypedQuestionAnswer(doc, 'foreign', 'yes', T0 + 1), undefined);
  assert.equal(claimTypedQuestionAnswer(doc, record.sessionKey, ' ', T0 + 1), undefined);
  assert.equal(claimTypedQuestionAnswer(doc, record.sessionKey, 'my answer', T0 + 1), record.id);
  assert.equal(claimTypedQuestionAnswer(doc, record.sessionKey, 'replay', T0 + 2), undefined);
  for (let index = 0; index < ASK_USER_LIMITS.retainedRecords; index++) {
    const [unknown] = ask({ idFor: () => index.toString(16).padStart(10, '0') });
    unknown.status = 'pending';
    doc.questions.push(unknown);
    markQuestionDeliveryUnknown(doc, unknown.id);
  }
  assert.equal(admitQuestionRecords(doc, ask({ idFor: () => 'ffffffffff' }), T0 + 10_000_000), 'invalid');
  assert.equal(doc.questions.filter((entry) => entry.status === 'unknown').length, ASK_USER_LIMITS.retainedRecords);
});

test('callback payloads are opaque, bounded and parsed only for this prefix and option set', () => {
  const payload = questionCallbackData('abcdef1234', 'c');
  assert.equal(payload, 'pq:abcdef1234:c');
  assert.equal(payload.length <= ASK_USER_LIMITS.callbackDataChars, true);
  assert.deepEqual(parseQuestionCallback(payload), { questionId: 'abcdef1234', optionId: 'c' });
  assert.equal(parseQuestionCallback('pq:abcdef1234:z'), undefined);
  assert.equal(parseQuestionCallback('pq:abcdef1234'), undefined);
  assert.equal(parseQuestionCallback('oauth:abcdef1234:c'), undefined);
  assert.equal(parseQuestionCallback(undefined), undefined);
});

test('ask_user stays authorized after reopen even with agentHistory false, empty toolAllowlist and no integrations', { timeout: 30_000 }, async (t) => {
  const { mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
  const modules = join(packageRoot, 'node_modules/@earendil-works');
  const [
    { parseConfig },
    { openGateway },
    { ASK_USER_TOOL_NAME },
    { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
    { BACKGROUND_CONTEXT },
    { AgentDoc },
  ] = await Promise.all([
    import(new URL('../dist/config.js', import.meta.url).href),
    import(new URL('../dist/runtime.js', import.meta.url).href),
    import(new URL('../dist/questions/index.js', import.meta.url).href),
    import(`${modules}/pi-ai/dist/index.js`),
    import(`${modules}/chord/dist/context/index.js`),
    import(`${modules}/pi-durable/dist/index.js`),
  ]);

  const context = BACKGROUND_CONTEXT;
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ask-user-reopen-'));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'state');
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const model = { provider: 'ask-reopen-faux', modelId: 'synthetic' };
  const config = parseConfig({
    workspace,
    dataDir,
    model,
    allowedModels: [model],
    toolAllowlist: [],
    episodeSummary: { enabled: false },
  }, directory);

  const sessionKey = 'cli:ask-user-reopen';
  const openWith = (responses) => {
    const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId, name: 'Synthetic' }] });
    faux.setResponses(responses);
    const models = createModels();
    models.setProvider(faux.provider);
    return openGateway(config, context, { models, agentHistory: false });
  };

  let chatId;
  const first = await openWith([() => fauxAssistantMessage('ready')]);
  try {
    const chat = await first.conversationFor(sessionKey, context);
    chatId = chat.id;
  } finally {
    await first.close(context);
  }

  // Reopen without calling conversationFor: startup policy must still restore mapped chat
  // authority so ask_user stays offered and callable at call time.
  let delivered = [];
  let asked = false;
  const second = await openWith([
    () => {
      if (!asked) {
        asked = true;
        return fauxAssistantMessage([
          fauxToolCall(ASK_USER_TOOL_NAME, {
            questions: [{ question: 'Proceed after reopen?', options: [{ label: 'Yes' }, { label: 'No' }] }],
          }, { id: 'ask-reopen-call' }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('Question sent.');
    },
    () => fauxAssistantMessage('Question sent.'),
  ]);
  try {
    const reopened = await second.harness.conversation(chatId, context);
    assert.ok(reopened !== undefined, 'mapped chat exists after reopen');
    const agent = await second.harness.snapshot(AgentDoc, chatId, context);
    const toolNames = (agent?.tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name));
    const modelToolNames = (agent?.modelTools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name));
    assert.ok(toolNames.includes(ASK_USER_TOOL_NAME), `ask_user must remain in tools after reopen: ${toolNames}`);
    assert.ok(modelToolNames.includes(ASK_USER_TOOL_NAME), `ask_user must remain in modelTools after reopen: ${modelToolNames}`);

    const detach = second.askSurfaces.attach({
      owns: (key) => key === sessionKey,
      deliverQuestion: async (_key, question) => {
        delivered.push(question);
      },
    });
    try {
      const submission = await reopened.submit({ type: 'input', content: 'ask me after reopen', requestId: 'ask-reopen-1' }, context);
      assert.equal((await submission.wait(context)).status, 'done');
      assert.equal(delivered.length, 1, 'ask_user call succeeded on reopened mapped chat');
      assert.equal(delivered[0].question, 'Proceed after reopen?');
    } finally {
      detach();
    }
  } finally {
    await second.close(context);
  }
});
