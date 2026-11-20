# Owner questions (`ask_user`)

`ask_user` lets the model ask the owner of an authenticated chat a small number of
genuine decisions. It is a question-delivery capability, not a workflow engine: the
tool delivers the question, ends the turn, and the owner's answer arrives later as
an ordinary follow-up turn. Nothing is parked, so a restart, `/abort` or a process
crash can never leave a model coroutine or a task waiting for an answer.

## Scope

- Offered only in an authenticated mapped ordinary chat: the local CLI attach
  (`cli:*`), a mapped Telegram private chat, or a mapped app thread whose adapter
  is running. Root, channel-state, fork, worker, digest and scheduled-run
  automation conversations never receive the extension.
- It is not a `toolAllowlist` name and grants no coding, filesystem, network,
  channel-send, worker or scheduling authority. `toolAllowlist` neither enables nor
  suppresses it.
- The call-time check re-reads the host's validated mapped-chat set and resolves the
  session key from the conversation; neither value comes from the model.
- Delivery needs a *unique* live surface for that exact session. Two CLI
  attachments sharing one conversation, or no attached channel, make delivery
  ambiguous or impossible: the tool refuses with fixed text and admits nothing.

## Tool contract

One call carries 1-4 questions, each with 2-4 unique options; an optional
`expiresInSeconds` bounds the answer window (30-86400, default 900). Option labels
and descriptions are display text. A question that appears to collect a credential
or secret is refused before anything is admitted or sent. A conversation with an
outstanding question refuses a new question until the first is answered, expires or
is cancelled; the tool reports that fixed reason.

The tool admits each question in the conversation's own durable document
(`nanobot.ask-questions`, version 1, conversation scope, latest history, initial
fork), marks it `sending`, delivers it to the live surface, then marks it
`delivered`. For the app channel the delivery itself is a durable append, so a
completed append is proof of delivery even when the tool's own mark was lost. It returns a bounded receipt naming the question ids, sets
`control.terminate`, and the run ends at that tool round: no further model request
is made and no answer is claimed in the tool result. Asking alongside another tool is refused
before delivery: the model must finish other work, then issue `ask_user` alone, because native
termination requires every result in the round to request it. A definite delivery failure marks the
question `failed`. An ambiguous external send is immediately quarantined as `unknown`, with an
honest unknown-outcome receipt, never reported as definite non-delivery or resent. A
crash between admission and delivery leaves `sending`; the next read quarantines it
as `unknown` after five minutes and never re-sends it.

## Answering

Each question is rendered and answered independently: one accepted option is one
bounded follow-up turn (a multi-question call therefore produces up to four
follow-up inputs over time, never a combined fabricated answer).

- **Telegram** renders the question with one inline button per option. `callback_data`
  is `pq:<10 hex question id>:<a-d option id>` — at most 15 bytes, never a label and
  never a secret. A press is authenticated against the exact private chat, the
  bound admitted sender and the current allowlist. The durable claim and the
  follow-up input admission share one commit: a duplicate, stale, expired, cancelled
  or replayed press gets one fixed acknowledgement and can never admit a second
  turn. Accepted answers are admitted as an ordinary input entry
  (`nanobot.ask-answer`) with fixed text `Answered question <id>: <label>`, so the
  existing delivery path sends the run's reply. The keyboard is removed best effort
  after any terminal outcome; a later press is still refused by the durable record.
- **App** (protocol v2, `question` event) appends one durable event with
  `state: "open"` in the thread's log; every later change (`answered`, `expired`,
  `cancelled`, `unknown`) is another event for the same id and the app keeps the
  latest. The channel also remembers the last state it published per id, so an
  event trimmed by retention is never published again. Tapping sends `answer {thread, question, option}`; the gateway claims
  the record against that exact thread session and admits the stored label
  (`Answered question <id>: <label>`) as the follow-up turn in one commit, replies
  `accepted: true`, then publishes the `answered` event. A refused tap replies
  `accepted: false`, appends one fixed notice and admits nothing. A typed ordinary
  message settles the oldest delivered question in that thread in the same commit
  as its admission, exactly like Telegram and the CLI, and `/new` cancels pending
  questions with the reset; archiving the thread cancels them with the archive, and
  restoring it does not reopen them.
- **Local terminal** has no button protocol: the question is printed with numbered
  options and the owner types an answer as an ordinary message. Attaching prints
  questions that are still open in that conversation, so a gateway restart does not
  hide an outstanding decision. The next non-empty ordinary text input settles the oldest delivered
  question for that exact session in the same commit as input admission, without duplicating the
  answer text in question state. This frees the chat to ask again and prevents reprinting an answered
  question on reattach. For multiple questions, successive typed inputs answer them in delivery order.

Only the option label from the stored record is admitted, never the callback payload,
so a forged or stale payload cannot inject text. The callback id, chat id, sender and
answer are validated in that order. A reply the owner types instead of pressing a
button is an ordinary message: Telegram, the CLI and the app atomically settle the oldest delivered
question when admitting it. Commands, empty text and attachment-only inputs do not count as typed
answers. A later button for that answered question is refused as a replay.

## Expiry and cancellation

Expiry is enforced when a question is read or claimed, not by a timer. An overdue
`pending` question becomes `expired`; a foreign session, unknown id or superseded
record answers `stale`; an already-answered one answers `replay`. `/new` (a context
reset) cancels every pending question in that conversation in the same operation,
because an answer would otherwise start a turn whose context no longer contains the
question. `/abort` and a host restart do not cancel questions: the answer is still a
meaningful next turn, and an expired or cancelled button is refused with fixed text.

## Retention and limits

At most 24 records are kept per conversation. Pending and unknown-outcome records are never evicted;
definitive terminal records are pruned after 30 minutes, oldest first. New admissions refuse when
retained unknown outcomes fill the bound. Questions, labels,
descriptions, session keys and admitted answer text are bounded (500/60/200/200/600
characters). No host path, credential, transcript entry or other chat's text is
stored in the question document.

## Known limitations

- Discord has no question surface yet. The tool is offered in a mapped Discord chat
  like any other mapped chat, and refuses with fixed text because no surface owns
  that session.
- A surface that disappears permanently (for example a CLI that never reattaches)
  leaves its questions to expire lazily; no background timer retracts a rendered
  message.
- A scheduled run in `origin` mode shares its chat's conversation class. If the model
  asks a question during such a run, the run ends at that tool round like any other
  ask; the owner sees the question and answers later.
