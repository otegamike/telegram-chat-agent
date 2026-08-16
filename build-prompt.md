# Build Prompt: Telegram AI Auto-Responder

You are building a Node.js/TypeScript service that reads incoming Telegram
DMs on Mike's personal account, drafts replies in his voice via an LLM,
sends drafts to a private review bot for approval/editing, and sends the
final text from Mike's real account.

**Work through the phases below IN ORDER. After finishing each phase, stop
and tell Mike exactly what to test and how, before moving to the next
phase.** Do not skip ahead or combine phases, even if the next phase looks
quick — each one needs to be verified working on real hardware (his Android
phone, via Termux) before the next is built on top of it.

## Global conventions
- **You (the agent) write and run all code on Mike's laptop.** Termux only
  exists on Mike's Android phone — you don't have access to it and should
  never assume you're running inside it. Any command you run yourself
  (npm install, build, lint, etc.) happens in the laptop environment.
- **The phone is for testing real Telegram behavior and eventual hosting,
  not for development.** After each phase, Mike commits and pushes from
  the laptop, then pulls on the phone inside Termux and runs the test gate
  there — because the point of each gate is confirming the code behaves
  correctly against real Telegram accounts and the phone's environment,
  not just that it compiles on the laptop.
- TypeScript, Node.js
- No Tailwind / no framework CSS — the admin web frontend must use vanilla
  CSS/JS only
- MongoDB via Mongoose (Atlas free tier) — reachable from both laptop and
  phone, so this is the one piece you can sanity-check yourself on the
  laptop before Mike re-verifies on the phone
- Anything Mike wants to change at runtime (freely, without committing)
  lives in MongoDB, never in code: `MasterPrompt` (the AI's voice, editable
  and assignable per chat), `ChatConfig` (which chats get auto-replied to),
  and `AdminUser` (the web admin login). Source code only ever contains
  obviously-fake placeholder seeds for these — never Mike's real prompt
  text and never credentials — so they never end up on GitHub
- All secrets in `.env`, never committed — `.gitignore` must include `.env`
  from the very first commit
- Provide an `.env.example` with every required key name but no real values
- At the end of each phase: commit, push, and tell Mike explicitly to
  `git pull` on the phone and run the test gate there before you continue

---

## Phase 1 — Project scaffolding + database models
- `npm init`, TypeScript config, folder structure (`src/models`,
  `src/services`, `src/bots`, `src/utils`)
- `.gitignore` (must include `.env`, `node_modules`, `*.log`)
- `.env.example` listing: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
  `TELEGRAM_SESSION_STRING`, `REVIEW_BOT_TOKEN`, `REVIEW_BOT_OWNER_CHAT_ID`,
  `MONGODB_URI`, `GROQ_API_KEY`
- Mongoose connection helper (`src/services/db.ts`)
- `Conversation`, `Draft`, `MasterPrompt`, and `ChatConfig` models exactly
  as specified below:

```ts
// Conversation
{
  chatId: string,
  peerUsername: string,
  messages: [{ role: 'them' | 'me', text: string, timestamp: Date }],
  summary: string,
  lastUpdated: Date
}

// Draft
{
  chatId: string,
  incomingMessage: string,
  draftText: string,
  finalText: string | null,
  status: 'pending' | 'sent' | 'skipped',
  wasEdited: boolean,
  createdAt: Date
}

// MasterPrompt — the AI's voice; lives in Mongo, never committed
{
  key: string,               // stable id, e.g. 'default'
  name: string,              // label shown in the admin UI
  chatId: string | null,     // null = global default; set = that chat's prompt
  systemPrompt: string,      // tone rules
  fewShotExamples: [{ trigger: string, reply: string }],
  correctionsBlock: string | null,
  enabled: boolean,
  createdAt: Date,
  updatedAt: Date
}

// ChatConfig — contact auto-reply filter (allow-list, default OFF)
{
  chatId: string,            // a contact's DM chat id (unique)
  peerUsername: string,
  autoReplyEnabled: boolean, // default false
  createdAt: Date,
  updatedAt: Date
}
```

- A tiny script (`src/scripts/test-db.ts`) that connects, inserts one test
  `Conversation` doc, reads it back, prints it, and exits.

**Test gate:** Mike pulls to his phone, runs the test script inside Termux
against his real Atlas URI, and confirms a document appears in Atlas's web
dashboard.

---

## Phase 2 — Review bot skeleton
- Register a bot with @BotFather, get the token
- `node-telegram-bot-api` in polling mode
- Bot ignores every message except from `REVIEW_BOT_OWNER_CHAT_ID`
- Responds to `/start` with a static confirmation message

**Test gate:** Mike messages his own bot from his phone and gets the
confirmation. He also messages it from a second account (or asks a friend
to) and confirms it's silently ignored.

---

## Phase 3 — GramJS auth + read-only listener
- One-time interactive login script producing `TELEGRAM_SESSION_STRING`
  (run once by Mike, value saved to `.env`, never committed)
- Listener using that session, subscribed to `NewMessage` events, filtered
  to private one-on-one chats only (ignore groups/channels/bots)
- For now, just `console.log` the chat ID, sender, and message text —
  no AI, no database writes yet

**Test gate:** Mike has a friend (or a second account he controls) send a
test DM to his real account, and confirms it's logged correctly in the
Termux terminal.

---

## Phase 4 — DB-backed master prompts + ChatConfig + draft generation
- `src/prompts/master-prompt.ts` holds SEED-ONLY placeholder content: tone
  rules plus 3-4 obviously-fake few-shot examples. It exists purely to
  bootstrap the DB — the real prompt lives in MongoDB and Mike edits it in
  the admin UI (Phase 5), so his actual voice never gets committed
- Mongo-backed prompt service (`src/services/master-prompt.ts`):
  `ensureDefaultMasterPrompt()` seeds a global default from the placeholder
  file if none exists, and `resolveMasterPrompt(chatId)` returns the chat's
  own enabled prompt if it has one, else the global default
- Groq client wrapper (`src/services/llm.ts`) exposing
  `generateDraft(incomingMessage, conversationContext, masterPrompt)`. It
  composes the system message from the passed-in prompt (tone rules +
  few-shot examples + `correctionsBlock` when present) and returns the
  model's reply text. Model = `GROQ_MODEL` env or a current supported
  default (Groq deprecated its Llama chat models as of 2026)
- A test script (`src/scripts/test-draft.ts`, run via `npm run test:draft`)
  that connects Mongo, resolves the default prompt, calls `generateDraft`
  with a hardcoded sample message, and prints the draft

**Test gate:** Mike sets `GROQ_API_KEY` in `.env`, runs the script, reads
the printed draft, confirms it's coherent and roughly follows the
placeholder tone rules, and confirms a `MasterPrompt` doc appears in Atlas.

## Phase 5 — Admin web frontend (DONE)
- `express` + `bcryptjs` (pure JS — must not break Termux ARM), vanilla
  HTML/CSS/JS only, no frontend build tooling
- `AdminUser` stored in Mongo (username + hashed password, never committed)
  with an `npm run create-admin` script to set it
- Login-protected single-page UI at `/admin` (server started by
  `npm run admin` on `ADMIN_PORT`) that can:
  - List / create / edit / delete `MasterPrompt`s: edit the systemPrompt
    and few-shot examples, assign a prompt to a specific `chatId` (or leave
    it as the global default), enable/disable
  - List `ChatConfig`s and toggle `autoReplyEnabled` per chat
- **Chat directory sync (added):** a `TelegramChat` collection holds the
  user's 1:1 chats. It is populated by `npm run sync-chats` and
  automatically on service startup via `src/services/telegram-chats.ts`
  (`syncChatDirectory` — `getDialogs` filtered to private real users, no
  bots). The admin **never connects to the Telegram session**: the Chats
  tab's picker reads `GET /api/chats` straight from Mongo.
- **Chat detail page (added):** clicking a chat in the allow-list opens
  `/chat.html?chatId=...` (`public/chat.html` + `public/chat.js`, served
  with the same cookie session). It shows the chat header + auto-reply
  toggle, a per-chat `MasterPrompt` editor (with a "create chat-specific
  prompt from default" button when the chat only inherits the global
  default), a conversation history UI (`Conversation.messages` bubble
  layout, themed rows / my rows, `summary` banner, and a "No messages yet"
  empty state), and the corrections list (`Draft` rows with status badges;
  edited drafts show incoming → draft → final).
- The whole thing is one JSON API + static pages; keep it minimal

**Test gate (DONE):** Mike logs in on the laptop, creates/edits a prompt,
saves, re-runs `npm run test:draft`, and sees the new voice; toggles a
chat's auto-reply and confirms the change in MongoDB; runs `npm run
sync-chats`, picks a chat from the dropdown, opens its detail page, and
confirms the per-chat prompt can be created/saved and the history shows the
empty state.

---

## Phase 6 — Wire listener → draft → review notification (DONE)
- On an incoming private DM: **allow-list gate first** — look up the
  sender's `ChatConfig`. If `autoReplyEnabled` is false (or no `ChatConfig`
  exists), ignore the message entirely: no history, no prompt, no draft, no
  notification
- If enabled, load-or-create `Conversation`, append the message
  (`role: 'them'`) to the rolling window, and save
- Resolve the chat's `MasterPrompt` via `resolveMasterPrompt`, call
  `generateDraft` with the recent context, and save a `Draft` doc with
  status `pending`
- Send the draft to the review bot chat with inline keyboard buttons:
  ✅ Send  ✏️ Edit  ❌ Skip
- Pipeline lives in `src/services/pipeline.ts`, invoked from
  `src/bots/message-listener.ts`; notifications are sent via a shared
  `sendDraftNotification` helper exported from `src/bots/review-bot.ts`

**Test gate (DONE):** Mike has a friend DM him. Nothing happens until he
enables that friend's `ChatConfig` in the admin UI (Phase 5); once enabled,
within a few seconds he gets a push notification from the review bot
showing the drafted reply with the three buttons visible. Chat off the
allow-list → ignored entirely (no `Conversation`/`Draft` created).

---

## Phase 7 — Review bot actions + send-back (DONE)
- **Per-chat review manager** (`src/services/review-manager.ts`): a state
  machine that owns one live draft per chat and routes review-bot input.
  States per chat: `idle → drafting → awaiting → editing`. Other chats keep
  working independently while one waits for review.
- **One live draft per chat**: if a new DM arrives while the chat is
  `drafting`/`awaiting`/`editing`, the message is appended to the
  conversation but only the **latest** one is queued
  (`queuedLatest`) — it gets drafted automatically once the current draft
  resolves, with all burst messages preserved in the context window.
- **Send**: cancel that chat's auto-send timer, mark
  `Draft.status = 'sent'`, `finalText = draftText`, send `finalText` to the
  original `chatId` via the GramJS client (`sendAsUser`),
  `role: 'me'` appended to the conversation, notification edited to
  `[Sent] …`, then draft the queued message if one arrived.
- **Skip**: mark `Draft.status = 'skipped'` (no send), notification edited
  to `[Skipped] …`, then draft the queued message.
- **Edit**: one edit-awaiting state at a time (global) — a second Edit tap
  is refused until the first resolves. Tap ✏️ → stop that chat's timer,
  move to `editing`; Mike's **next message to the bot** is the replacement
  text for that draft (`wasEdited = true`, `finalText`, send via GramJS,
  `role: 'me'` appended, notification edited to `[Edited & sent] …`).
  Bot messages in non-edit states are ignored.
- **Auto-send timer**: when a draft notification is sent, schedule an
  auto-send. Delay comes from a `Settings` doc
  (`src/models/Settings.ts`, key `global`, field `autoSendDelayMs`,
  seeded from `AUTO_SEND_DELAY_MS` env || 240000, editable in the admin
  Settings tab at `GET/PUT /api/settings`, `0` = disabled). If the draft is
  still `pending` when the timer fires, send it and mark auto-sent; timers
  are killed by Send/Edit/Skip. Timers are in-memory (a restart drops
  pending ones; drafts stay `pending` in Mongo).
- **Review bot module** (`src/bots/review-bot.ts`) owns only Telegram
  plumbing: `setReviewHandlers({ onCallbackQuery(action, draftId),
  onOwnerText(text) })` lets the manager register callbacks without the
  bot importing the manager. `sendDraftNotification` returns the
  notification `message_id`; `editDraftNotification(messageId, text)`
  updates the text (and removes the keyboard).
- Pipeline (`src/services/pipeline.ts`) exposes the reusable single-message
  core: `buildContext`, `loadOrCreateConversation`, `appendIncomingMessage`,
  `appendSentMessage`, and `draftReply(info)` → `DraftedReply
  { draftId, draftText, notificationMessageId }`.

**Test gate (DONE — laptop-verified; phone re-check deferred by Mike):**
friend sends a message → notification → tap Edit → Mike sends a rewritten
reply to the bot → friend receives the edited text from his real account.
Repeat with Send (no edit). Then: friend sends a message and Mike does
nothing → the draft auto-sends after the configured delay (edit the delay
down to ~30s in the admin Settings tab first). Finally, friend fires 3
messages in a row → exactly one notification; after Mike resolves it, the
latest message gets drafted and sent.

---

## Phase 8 — Rolling memory: topic-based summarization + context selection (CURRENT — in progress)
**Schema change** — replace `Conversation.summary: string` with a structured
topics array (archived defaults `false`):
```ts
topics: [
  { label: string, summary: string, lastMentioned: Date, archived: boolean }
]
```
- **Trimming strategy — simple per-message fold.** Cap `messages` at 20.
  The moment a new message would push the array past 20, immediately fold
  the oldest entry (or entries) out via **one** summarization LLM call —
  no batching, no buffer. `src/services/llm.ts` `foldTopicsIntoHistory(
  currentTopics, evictedMessages)` returns a NEW topics JSON array
  (raw JSON only, parsed defensively): for each evicted message either
  update an existing topic's `summary` (condense, never append unbounded)
  and `lastMentioned`, or create a new entry if it matches nothing.
  `archived` status of existing topics is preserved across folds. On LLM
  failure the messages are still pruned, prior topics kept, error logged.
  Trimming runs from `trimConversation` inside `appendIncomingMessage` and
  `appendSentMessage` (`src/services/pipeline.ts`).
- **Context selection for `generateDraft` — deterministic, no extra LLM
  call.** `src/services/topics.ts` `selectTopicsForContext(topics,
  incomingText)` is pure and synchronous:
  - **Recency floor:** always include the 3 most-recently-mentioned
    non-archived topics, regardless of keyword match (catches vague refs
    like "did that end up happening?").
  - **Keyword boost:** additionally include non-archived topics sharing a
    lowercase token overlap (len ≥ 3) with the incoming message's
    `label`/`summary` (catches an old topic resurfacing by name).
  - **Cap at 8 total.** Logs the selected labels before each draft.
  - `buildContext(messages, selectedTopics)` prepends the selected topics
    block before the 20-message window; `draftReply` wires selection in.
- **Topic maintenance job** (`src/services/maintenance.ts`,
  `scheduleTopicMaintenance` — daily `node-cron`, default `0 3 * * *`,
  overridable via `MAINTENANCE_CRON`; also `npm run maintain` to run now):
  per conversation, ask the LLM to merge near-duplicate entries
  (`mergeDuplicateTopics`: combine summaries, keep most recent
  `lastMentioned`, `archived` = OR), and set `archived: true` on topics not
  mentioned in 90+ days. **Archived topics are excluded from context
  selection but never deleted.** Run-guarded against overlaps.

**Test gate:** run `npm run test:memory` on the laptop (seeds a throwaway
chat, then checks: messages stay capped at 20; two distinct subjects produce
separate topics; a vague follow-up is picked up by the recency floor;
backdating a topic 100 days → maintenance archives it and it drops out of
selection; near-duplicate topics get merged). On-device equivalent: have a
friend send 20+ messages spanning two subjects and confirm in MongoDB the
array stays at 20, topics holds separate per-subject entries, and a new
message about one subject drafts with that subject's topic selected.

---

## Phase 9 — Voice-correction feedback loop
- A scheduled job (`node-cron`, run daily or on-demand) that queries the
  most recent `Draft` docs where `wasEdited = true`, and builds a
  "recent corrections" block (original → final, last ~10)
- Store that block in `MasterPrompt.correctionsBlock` so it participates in
  future `generateDraft` calls (surfaced in the admin UI too)

**Test gate:** Mike manually edits a couple of drafts, runs the job, and
confirms the corrections block updates and that a subsequent draft for a
similar message shows the influence (e.g. adopts a phrase he corrected to).

---

## Phase 9b — Connection watchdog + unread catch-up
- **Problem:** GramJS auto-reconnects internally but logs nothing usable
  (`Handling reconnect!` at `TelegramClient.js:1044`) and its public
  `catchUp()` is a no-op (`client/updates.js`). After a network drop the
  service looks "stuck" until timeout or manual restart, and messages
  received during downtime are never drafted.
- **Connection watchdog** (`src/services/watchdog.ts`):
  - Install a `Raw` event handler watching `UpdateConnectionState` and log
    clear transitions: `connected` / `disconnected` / `broken` with timestamps.
  - `startConnectionWatchdog(client)`: every `WATCHDOG_INTERVAL_MS` (30s)
    check `client.connected`; if the client has been down continuously for
    `WATCHDOG_STUCK_MS` (3min), force `disconnect()` → `connect()` →
    re-verify auth, then run catch-up.
  - Retry-capped: recover at most `WATCHDOG_MAX_RECOVERIES` (10) times, then
    log "waiting for manual restart" and stop — **never** `process.exit`,
    never spin forever. GramJS already retries forever with 2s backoff by
    default (`MTProtoSender.DEFAULT_OPTIONS`), so the watchdog adds only
    supervision + visibility, not more connection attempts.
  - Applies on every transition back to connected too.
- **Unread catch-up** (`src/services/catch-up.ts`): push missed incoming
  messages through the normal draft/review flow.
  - Allow-list only (`ChatConfig.autoReplyEnabled`). One
    `client.getDialogs({ limit: 200 })` pass builds the read boundary.
  - Per chat `client.getMessages(chatId, { limit: CATCHUP_MESSAGE_LIMIT })`,
    filter `!m.out` + has text + `m.id > max(watermark, readInboxMaxId)`,
    sort ascending, `handleIncoming` each. **Unread-only** — anything Mike
    read in-app while down is intentionally skipped.
  - **First run starts fresh:** when a chat has no watermark yet, snapshot
    `topMessage` as the starting line and record it — no backfill of
    pre-existing history.
  - Dedupe via `ChatConfig.lastProcessedMessageId` watermark: updated on
    every live event (`message-listener.ts`) and to `max(id)` after each
    run — prevents Skip-message re-drafts.
  - Runs at startup (after sync) and after every watchdog reconnect.
    Manual on-demand: `npm run catch-up` (`src/scripts/run-catch-up.ts`) —
    same idempotent code path (harmless alongside the live service).
- Env knobs (`.env.example`): `CATCHUP_ENABLED`, `CATCHUP_MESSAGE_LIMIT`
  (25), `CATCHUP_MAX_AGE_HOURS` (168), `WATCHDOG_INTERVAL_MS` (30000),
  `WATCHDOG_STUCK_MS` (180000), `WATCHDOG_MAX_RECOVERIES` (10).

**Test gate (laptop):** while the listener is down, DM the session account
from a second account → restart `npm start` → confirm the message lands as
a draft in the review bot and (after the auto-send delay) reaches the
friend. Disable/block networking → watch `disconnected`/`broken` logs →
re-enable → confirm `connection re-established` + catch-up runs. Then skip
a notification and re-run `npm run catch-up` → that message is NOT
drafted again (watermark).

---

## Phase 10 — Hosting hardening on Termux
- Document (in README) the wake-lock, battery-optimization-exemption, and
  Termux:Boot autostart steps already established
- Wrap the main process start in `tmux` so it survives the Termux app being
  backgrounded; run the admin server (`npm run admin`) the same way so the
  UI stays reachable from the LAN
- Add a `README.md` section with an explicit note on the Telegram ToS risk
  of the GramJS session, and Mike's usage guidelines (never message first,
  keep volume low, always review before send)

**Test gate:** Mike reboots his phone, confirms the service auto-starts via
Termux:Boot without him opening the app manually, and that a test message
still triggers the full pipeline afterward.

## After Phase 10
Stop and summarize what was built, flag anything that still needs real
content from Mike (his actual few-shot examples of his texting voice are
the single highest-leverage remaining task — enterable in the admin UI),
and ask what he wants to tackle next.
