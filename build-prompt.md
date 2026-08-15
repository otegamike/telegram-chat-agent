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

## Phase 6 — Wire listener → draft → review notification (CURRENT — in progress)
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
- No button handling yet — just confirm the notification arrives correctly
- Pipeline lives in `src/services/pipeline.ts` (`processIncomingMessage`),
  invoked from `src/bots/message-listener.ts`; notifications are sent via a
  shared `notifyDraft` helper exported from `src/bots/review-bot.ts`

**Test gate:** Mike has a friend DM him. Nothing happens until he enables
that friend's `ChatConfig` in the admin UI (Phase 5); once enabled, within
a few seconds he gets a push notification from the review bot showing the
drafted reply with the three buttons visible (even though tapping them
doesn't do anything yet). Chat off the allow-list → ignored entirely (no
`Conversation`/`Draft` created).

---

## Phase 7 — Review bot actions + send-back
- Handle `callback_query` for Send / Edit / Skip
- **Send:** mark `Draft.status = 'sent'`, `finalText = draftText`, send
  `finalText` to the original `chatId` via the GramJS client
- **Skip:** mark `Draft.status = 'skipped'`, no send
- **Edit:** bot replies asking for the replacement text; track "awaiting
  edit for draft X" state; on Mike's next message to the bot, treat it as
  `finalText`, set `wasEdited = true`, send it via GramJS, mark `sent`

**Test gate:** Full round trip — friend sends a message, Mike gets the
notification, taps Edit, sends a rewritten reply to the bot, and confirms
his friend receives the edited text from his real account (not the bot).
Repeat once tapping Send directly (no edit) to confirm that path too.

---

## Phase 8 — Rolling memory + summarization
- Cap `messages` array at ~20 entries per conversation
- When it would exceed the cap, summarize the oldest entries into
  `Conversation.summary` via an LLM call, then trim the array
- Include `summary` in the context passed to `generateDraft`

**Test gate:** Mike simulates (or has a friend send) 20+ messages in one
chat, confirms the array stays capped in MongoDB and `summary` gets
populated and makes sense.

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
