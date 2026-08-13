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
- No Tailwind / no framework CSS — this project has no UI, so this
  shouldn't come up, but if any admin page is ever added, vanilla CSS only
- MongoDB via Mongoose (Atlas free tier) — reachable from both laptop and
  phone, so this is the one piece you can sanity-check yourself on the
  laptop before Mike re-verifies on the phone
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
- `Conversation` and `Draft` models exactly as specified below:

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

## Phase 4 — Draft generation (standalone, not yet wired to Telegram)
- Master prompt file (`src/prompts/master-prompt.ts`) with placeholder
  sections for tone rules and few-shot examples — Mike will fill in real
  examples later, use 3-4 obviously-fake placeholder examples for now so
  the phase is testable
- Groq client wrapper (`src/services/llm.ts`)
- A function `generateDraft(incomingMessage, conversationContext)` that
  composes the prompt and returns the model's reply text
- A test script that calls this function directly with a hardcoded sample
  message and prints the draft

**Test gate:** Mike runs the script, reads the printed draft, confirms it's
coherent and roughly follows the placeholder tone rules.

---

## Phase 5 — Wire listener → draft → review notification
- On incoming message: load-or-create `Conversation`, append to rolling
  window, call `generateDraft`, save a `Draft` doc with status `pending`
- Send the draft to the review bot chat with inline keyboard buttons:
  ✅ Send  ✏️ Edit  ❌ Skip
- No button handling yet — just confirm the notification arrives correctly

**Test gate:** Mike has a friend DM him, and within a few seconds gets a
push notification from the review bot showing the drafted reply with the
three buttons visible (even though tapping them doesn't do anything yet).

---

## Phase 6 — Review bot actions + send-back
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

## Phase 7 — Rolling memory + summarization
- Cap `messages` array at ~20 entries per conversation
- When it would exceed the cap, summarize the oldest entries into
  `Conversation.summary` via an LLM call, then trim the array
- Include `summary` in the context passed to `generateDraft`

**Test gate:** Mike simulates (or has a friend send) 20+ messages in one
chat, confirms the array stays capped in MongoDB and `summary` gets
populated and makes sense.

---

## Phase 8 — Voice-correction feedback loop
- A scheduled job (`node-cron`, run daily or on-demand) that queries the
  most recent `Draft` docs where `wasEdited = true`, and builds a
  "recent corrections" block (original → final, last ~10)
- Inject that block into the master prompt for future `generateDraft` calls

**Test gate:** Mike manually edits a couple of drafts, runs the job, and
confirms the corrections block updates and that a subsequent draft for a
similar message shows the influence (e.g. adopts a phrase he corrected to).

---

## Phase 9 — Hosting hardening on Termux
- Document (in README) the wake-lock, battery-optimization-exemption, and
  Termux:Boot autostart steps already established
- Wrap the main process start in `tmux` so it survives the Termux app being
  backgrounded
- Add a `README.md` section with an explicit note on the Telegram ToS risk
  of the GramJS session, and Mike's usage guidelines (never message first,
  keep volume low, always review before send)

**Test gate:** Mike reboots his phone, confirms the service auto-starts via
Termux:Boot without him opening the app manually, and that a test message
still triggers the full pipeline afterward.

---

## After Phase 9
Stop and summarize what was built, flag anything that still needs real
content from Mike (the actual few-shot examples of his texting voice are
the single highest-leverage remaining task), and ask what he wants to
tackle next.
