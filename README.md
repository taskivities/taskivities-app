# Taskivities

A team's week at a glance: everyone records their daily tasks against a project. Tasks can be assigned or transferred to anyone on the project, every change is kept in an append-only history, overdue tasks roll into today until someone finishes or moves them, and every open browser updates on its own.

The design reference is [`docs/wireframes.html`](docs/wireframes.html). Open it in a browser.

## Stack

| Part | What |
|---|---|
| App | React 19 + TypeScript, built with Vite, served as static assets by the Worker |
| API | One Cloudflare Worker using [Hono](https://hono.dev) (`worker/`) |
| Database | Cloudflare D1 (SQLite). Schema in `migrations/` |
| Sign-in | Google OAuth (code + PKCE) and, optionally, WorkOS AuthKit (emailed codes, Microsoft, passkeys) for people without Google; handled in the Worker, with HttpOnly session cookies stored in D1 |
| Live updates | The browser polls `/api/sync?since=<version>` every 10s (every 60s when the tab is hidden) |
| AI assistants | Remote MCP server at `/mcp` (Streamable HTTP) on the same Worker: Cloudflare's `agents` SDK (`McpAgent`, one Durable Object per session) behind `@cloudflare/workers-oauth-provider` (OAuth 2.1 + dynamic client registration, tokens in KV) |

```
worker/   index.ts (routes + OAuth provider) · auth.ts (Google, WorkOS + sessions) · api.ts (REST: tasks, sync) · tasks.ts (task rules shared by REST and MCP)
          mcp.ts (MCP tools) · oauth.ts (/authorize consent page for assistants) · admin.ts (people, projects, settings) · settings.ts (logo) · gmail.ts + invite-mail.ts (invite emails) · webhooks.ts · lib.ts
shared/   types, date helpers and rules used by both the Worker and the app
src/      React app: pages/ (Tasks and Projects: a person's or a project's view; Team: the People & projects page; Settings; Login), components/, actions.ts (all writes), keyboard.ts, focus.ts
migrations/ (0001 schema, 0002 time zones, 0003 repeating tasks, 0004 settings, 0005 Gmail tokens, 0006 webhooks, 0007 checklists, 0008 attachments, 0009 upload links, 0010 archive, 0011 disabled people, 0012 archived projects, 0013 notifications, 0014 inbox, 0015 followers, 0016 effort, 0017 other instances)   seed/dev.sql (local sample data)
scripts/tenant.mjs (per-instance deploys)   tenants/ (each instance's Cloudflare IDs; only example.env is committed)
```

## Rules the code enforces

- **Every task has a project, a due date, an assignee and a priority.** The columns are `NOT NULL`, and the API rejects any attempt to clear them.
- **"Today" is each person's own today.** The browser sends its time zone with every request (`x-tz`), and the server uses it for rollover, the "can't be due in the past" check, and the day a task counts as done. It's also saved on the person, so their AI assistant uses the same zone. `TEAM_TZ` is only a fallback for someone who hasn't opened the app yet.
- **Rollover is computed, never stored.** An open task with a past due date is shown on today, and "days late" keeps counting (`shared/rules.ts → shownOn`). There's no nightly job.
- **Repeating tasks** (`shared/repeat.ts`, `worker/tasks.ts`):
  - **Repeating is set when a task is created.** Afterwards the rule can be changed or stopped, but a normal task can't be turned into a repeating one, and stopping can't be undone.
  - A `series` row holds the rule (daily, weekly on chosen days, monthly by date or by "2nd Tuesday", yearly, every N, optional "after done", end date or count) and the defaults for future copies. Each copy is an ordinary task with its own history and a `series_id`.
  - **One open copy at a time.** Marking a copy done inserts the next one in the same D1 batch, guarded by "no open copy in this series", so two people finishing it at once can't create two. There's no scheduled job.
  - Missed dates aren't piled up: an unfinished copy rolls over like any task, and the next copy always lands after today.
  - **Skip** moves the open copy to the next scheduled date. Reopening a finished copy leaves the next copy in place.
  - Edits to the open copy (title, notes, priority, project, assignee) carry forward to future copies, except a transfer marked "just this one". Date moves only affect that copy.
  - The week views show upcoming copies as faint previews, calculated in the browser and never saved.
- **Install on a phone (home-screen app):** `/manifest.webmanifest` and `/icons/<180|192|512>.png` are served by the Worker, so the app opens full screen from a home-screen icon. Admins upload a square PNG on the **Settings** page (JPEG/WebP work too); the browser resizes it to each size on white (Workers can't resize images), and the server checks each is a PNG of exactly that size. Without one, the built-in icons in `public/default-icons/` are used. `public/sw.js` is a minimal service worker so phones offer to install it: it caches nothing, and only shows a "you're offline" page when a page can't load. The account menu offers **Install app** where the browser supports it, and explains Share → Add to Home Screen on iPhones. Safe-area padding keeps the top bar clear of the notch and the home bar.
- **Effort:** a project can track effort on its tasks in one of three preset ways (set in the project's editor): *Time spent* (one total per task, typed as "1h 30m", "90m", "1:30" or "1.5"), *T-shirt size* (XS–XL) or *Story points* (1, 2, 3, 5, 8, 13, 21). It can also be **required before a task is marked done**: ticking such a task without it asks for the effort first, and the server refuses it otherwise (from the app, the API or assistants). Effort is set in the task panel and shows as a small badge on rows and cards; it's in the history like any change. A project's view totals it: the day report and Copy summary show what got done ("1 done · 1h 30m"), and a project's week shows done and, for sizes and points, what's still planned ("8 pts done · 13 pts planned"). Stored as `'<type>:<value>'` on the task (migration 0016, rules in `shared/effort.ts`), so a task moved to a project that measures differently, or a project that changes type, keeps its old value without misreading it. A repeating task's next copy starts without effort.
- **Other instances (one place for all your tasks):** if you're on several Taskivities instances (say your team's and your own), connect them in your personal one (account menu → **Other instances**) and the tasks assigned to you there show up in your own day, week and board, labelled with that instance's name and project. From there you can mark them done or not (effort is asked for where that instance requires it), move them (Board drag included), change priority and effort, edit notes, tick checklists and comment; anything else (handing over, project, repeating, files, archive) says so and opens the task on its own instance. They stay out of this instance's lists: the switcher, project views, menus and People & projects.
  - **Connecting:** *Request access* sends you to the other instance, which asks you to approve (signed in there); you come back connected. Or make an access token there and paste it with its address. Either way the other instance keeps only a SHA-256 of a token (`access_tokens`), lists it under Other instances, and revoking it ends access at once. A token sees and changes only its owner's tasks, and its changes are recorded as theirs, marked "via Taskivities".
  - **How:** the browser never talks to the other instance. This instance keeps the token encrypted (AES-GCM; key from `TOKEN_KEY`, else the Google client secret, else the push key) in `feeds`, fetches `GET /feed/v1/tasks` there (open tasks and those due or done in the loaded days, with their projects and people) about every 45 seconds while the app is open, and passes changes on (`/api/feeds/<feed>/tasks/<id>…` → `/feed/v1/tasks/<id>…`). Their ids become `f~<feed>~<id>` here, and your account there becomes you here. Request and approve: `/connect` on the instance being shared shows the approval page, then sends a one-time code (10 minutes) back to `/connect/done`, which swaps it server to server (`POST /connect/exchange`) for a token. Only https addresses (plain http only between local development copies). Migration 0017; code in `worker/feed.ts`, `src/feeds.ts` and `src/components/InstancesSheet.tsx`. Both instances need this version or later.
- **Followers:** whoever has a task and everyone following it hear about its comments, when it's done or reopened, and when it's handed to someone (notifications and the inbox). The creator follows automatically; anyone can follow (**Follow** in the task, or **F**), add someone else on the project (shown in the history, and they're told), and commenting follows the task. Whoever has the task can't unfollow it. Followers who lose access to the project stop hearing about it. Stored in `task_followers` (migration 0015): the creator needs no row unless they stop following, so tasks made any way (app, assistants, webhooks, repeats) get it without extra writes; a repeating task's next copy keeps the followers. Rules in `worker/followers.ts`.
- **Inbox:** the bell in the top bar lists what other people did that needs you: tasks given to you (new or handed over, with the note), comments, done/reopened and handovers on tasks you have or follow, being added as a follower, your task handed to someone else, and handovers when someone is disabled (one row). New entries get a count on the bell, kept current by the 10-second sync; opening it marks them seen. Same people as notifications, but it doesn't depend on them: nothing is sent or stored per entry. It's a view of `task_events` (`worker/inbox.ts`), using partial indexes on who a task was made for or handed to (migration 0014), so it stays fast however long the history gets; `users.inbox_read_at` marks what's been seen. 50 entries at a time, newest first, with **Show older**.
- **Notifications (Web Push):** each person turns them on per device in the account menu (**Notifications**). They're told when someone else gives them a task (new or handed over, with the transfer note), what happens on tasks they have or follow (comments, done or reopened, handed to someone, being added as a follower), and, optionally, at 8:00 in their own time zone how many tasks are on their plate today. Never about their own changes; changes made by an assistant say "via Claude". Each kind can be switched off (`users.notify`). Tapping a notification opens the task. The installed app's icon shows a badge with today's open tasks.
  - Works on Android and desktop browsers, and on iPhone/iPad (iOS 16.4+) only in the app added to the Home Screen; the menu says so in Safari.
  - No outside service: the Worker signs (VAPID) and encrypts (RFC 8291) each message itself with WebCrypto (`worker/webpush.ts`) and posts it to the browser's push service (Google, Apple, Mozilla, Microsoft; others are refused). Sending happens after the response, so changes are never slower. Devices are stored in `push_subscriptions` (migration 0013) and dropped when the push service says they're gone, when they turn notifications off, or when the person is disabled.
  - The instance's key pair is created by the first `npm run deploy` and stored as the secrets `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Locally: `npm run -s push-keys >> .dev.vars`. Without keys the menu item is hidden. The morning summary runs on a Cron Trigger every 30 minutes (`wrangler.jsonc`).
- **Light and dark themes:** each person picks Light, Dark or System (follows the OS, live) in the account menu; it's saved in that browser. Every colour in `src/styles.css` comes from variables in `:root`, and `[data-theme="dark"]` swaps them; `index.html` applies the choice before the page draws, so there's no flash. Logos sit on a light tile in the dark theme, since they're usually drawn for light backgrounds. The assistant consent page follows the OS setting.
- **Attachments** (optional per instance; `worker/attachments.ts`, migration 0008): files live in an R2 bucket (binding `FILES`, `R2_BUCKET` in the tenants file); without one the app hides "Attach". Drop files on a task, paste a screenshot, or press **⇧A**. Up to 25 MB per file and 50 per task. Every download goes through the Worker, which checks the person can see the task; only images, PDFs and plain text open in the browser (under a sandboxing CSP), everything else downloads, so an uploaded HTML or SVG file can't run code. Only the uploader or an admin can remove a file: it's deleted from R2 and the history keeps its name. Rows show a 📎 count.
- **Checklist:** each task can have one checklist (`checklist_items`, migration 0007). Anyone who can see the task can add items (pasting several lines adds them all), tick, rename or remove them, and every change is logged in the history. Rows show progress ("2/5"). A repeating task's next copy starts with the same items, unticked. Press **⇧C** to jump to it (and **⇧N** for notes); empty notes and checklists fold into small "Add" buttons.
- **Comments** live in the task's history (`type = 'comment'`), so they're permanent like everything else there: no editing or deleting. Anyone who can see the task can comment, on open or done tasks, up to 4,000 characters. A comment moves the task's version on, so everyone's app picks it up on the next poll, and the assignee and creator get a "New comment" notice. Rows show a comment count. Press **C** on a task to comment.
- **Archive, not delete:** **Archive task** in a task's ⋯ menu archives it (deliberately not a one-click button or a shortcut): it leaves every list, count, sync and assistant listing at once (with Undo), and nothing is lost. Archived tasks, open or done, are listed only in a project's view, in a collapsed "Archived" section, where anyone on the project can restore them. An archived task can't be edited, commented on or ticked until it's restored. A repeating task whose open copy is archived pauses (no next copy) and carries on when restored. Migration 0010.
- **People and projects, one screen:** pick a person or a project from the switcher at the top of the page (P); there's no separate Projects page. The logo and G T go to your week, G P to the project you last looked at.
- **Copy what got done:** the copy button beside the week controls (Week and Board, and a person's Today) copies the tasks done in the days shown as one Markdown list: a title line with the range, the total effort (if any), then each task (oldest first) with its priority if Urgent or High, whose it is (in project views), its project and its effort (`src/copyDone.ts`). Effort is added up per type, so a mix reads "6h 15m · 13 pts".
- **Several at once:** **Several** in the switcher turns its rows into checkboxes. Several people show all their tasks together, several projects show those projects together, and people with projects show those people's tasks in those projects (an AND of the two lists). It's a project-style view (each row says whose it is), with Today, Week and Board, the day report, Copy summary and effort totals when every project in view measures effort the same way; each tick applies at once, and the choice is remembered on the device. One person alone, or one project alone, is their usual view; nothing ticked is All projects.
- **Board past one week:** the Board can show as many weeks as you like (− / + next to it, or the *Next week* column at its end, up to 52), side by side, scrolling sideways. Drag a card near either edge and the board scrolls by itself, so a task can go from Friday to Tuesday next week, or further. The number of weeks is remembered on each device; the Week list stays one week.
- **Projects in Today, Week and Board:** a project's view has the same three views as a person's. *Today* is the day report (what got done, by priority, with Copy summary, and any past day). *Week* and *Board* show every task in the project (or all your projects) day by day, whoever has it: each row or card shows its owner, carried-over tasks sit on today, upcoming copies of repeating tasks are shown, and cards drag to another day. The quick-add there puts new tasks in that project, for you. The choice of view and week is shared, so switching between a person and a project keeps it.
- **Switching between people and projects:** the picker at the top of either page (click the name, or press **P**) lists people and projects together: pick a project from someone's week to see the project's week, or a person from a project to see theirs.
- **Managing projects:** admins create, edit and archive projects on the People & projects page's Projects tab, or from the switcher while viewing a project (*New project…*, and *Edit project…* for the one shown). A project made from the quick-add's project menu becomes the new task's project.
- **Archiving projects:** admins archive an old project from its **Edit** sheet. It's hidden from everyone, admins included, together with all its tasks (open and done): lists, counts, sync, webhooks and assistants treat it like a project nobody is on, its repeating tasks pause and its webhooks stop making tasks. Nothing is deleted, and members keep their place on it. Archived projects are listed in a collapsed "Archived" section on the People & projects page's Projects tab, where an admin restores one and everything comes back as it was (a project of the same name has to be renamed first). Migration 0012.
- **Disabling people, not deleting them:** the ⊘ button on the People & projects page disables someone (after their open tasks are handed to someone on the same projects). They can't sign in, their assistants lose access, their Gmail connection is deleted, and they can't be assigned anything; but their row stays, every task's history still names them, and their projects are remembered. Disabled people are listed in a collapsed "Disabled" section, where an admin enables them again (members confirm or change their projects). Adding a disabled person's address again also enables them. You can't disable yourself or the last admin. Migration 0011 (it renames the old `removed` status to `disabled`).
- **History is append-only.** Every write updates `tasks` and inserts into `task_events` in the same D1 batch, and database triggers refuse any `UPDATE` or `DELETE` on `task_events`.
- **Roles:**
  - Admins see every project and are the only ones who manage people and projects.
  - Members see only the projects they're on.
  - A task's assignee must always be on that task's project.
- **Settings** (admins only, the **Settings** page, stored in the `settings` table):
  - **Logo:** SVG only, up to 256 KB. Used in the top bar, on the sign-in page and as the browser tab icon; "Use the built-in logo" goes back to the default. Every change is in the audit log, and everyone's app picks it up on its next poll.
  - **Name:** the team's name for the app, up to 40 characters (plain text). It replaces the TASKIVITIES lettering in the top bar and "Taskivities" on the sign-in page, in the browser tab, in the home-screen label (the manifest and the iPhone title) and in invite emails. Empty goes back to Taskivities. Optionally, a **wordmark** (an SVG of the name, checked like the logo and served at `/wordmark.svg` under the same locked-down CSP) replaces the text in the top bar and on the sign-in page. Both live in `settings` (`name`, `wordmark`); the demo refuses changes to them.
  - Uploads are checked in the browser and again on the server: no scripts, event handlers, embedded HTML, DOCTYPEs or links to outside files. `/logo.svg` is also served with a locked-down `Content-Security-Policy` (`sandbox`, no scripts), so even opening it directly can't run anything.
- **Webhooks** (Settings → Webhooks; `worker/webhooks.ts`, mapping rules in `shared/webhook.ts`):
  - Each webhook has a secret address, `POST /hooks/<token>` (JSON, form data, or GitHub/Slack-style `payload=` forms; up to 64 KB). "New address" replaces the token, and the old one stops working.
  - **A new webhook only collects samples.** Requests are stored (the last 15 per webhook), and the editor shows each one's fields as `body.…`, `headers.…` and `query.…`. Clicking a field puts `{{body.issue.title}}` into the title or notes, or picks it for the assignee, due date, priority, "only when" or "skip repeats" options. A live preview shows the task the selected request would create.
  - **Saving the mapping makes it live:** each request then creates a task, made by the admin who saved it and marked "via <name> webhook" in the history. The assignee can come from an email or name in the request (falling back to a chosen person on the project); the due date from a field (past or missing dates become today), a number of days, or today; the priority from words like `high`, `P1` or `2`.
  - Requests that don't match "only when" are **skipped**; a repeat of the same "skip repeats" value is a **duplicate**; a title field that's missing is an **error** (no half-empty tasks). Every request is logged with its result, and the sender gets a matching status code (201 created, 202 sample stored, 200 skipped, 422 error).
  - Credentials and IP addresses in headers (`authorization`, cookies, `x-forwarded-*`, Cloudflare's client IP headers) are never stored. Pause keeps logging without creating tasks; "Stop & edit samples" goes back to collecting.
- **Invite emails** (optional, per admin; `worker/gmail.ts`):
  - An admin connects their Gmail on the **Settings** page. Google is asked for **`gmail.send` only**: the app can send mail as them, never read it. After that, adding people (and the resend button on the People & projects page) emails each one an invite from the admin's own address, with a sign-in button.
  - The refresh token is stored encrypted (AES-GCM) in `google_tokens`, with a key derived from `GOOGLE_CLIENT_SECRET` (or the optional `TOKEN_KEY` secret). Disconnecting deletes it and revokes it at Google; disabling the person deletes it too.
  - **It never blocks adding people.** Not connected, the permission unticked, a revoked or expired token, the Gmail API off, or a Gmail error: the person is still added, and the admin is offered the sign-in link to share. A connection Google no longer accepts is dropped so the app shows "not connected" again.
  - It reuses the sign-in callback (`/auth/callback`), so there's no extra redirect URI to register, and it only connects the Google account the admin signs in with.
- **Sign-in:** only email addresses added by an admin can sign in. On a brand-new install, the **first person to sign in becomes the admin** (the check is one atomic insert, so only one person can win). The optional `ADMIN_EMAILS` secret names addresses that are always let in as admins, which is useful for getting back in if you lock yourself out.
- **Writes come only from the app's own pages:** they need the same origin plus a custom header, and the session cookie is `SameSite=Lax`. The one exception is `/mcp`, which takes an OAuth bearer token instead (see below).
- **One set of task rules.** The REST API and the MCP tools both call `worker/tasks.ts` (`createTask`, `applyPatch`), so visibility, "assignee must be on the project" and "no past due dates" can't diverge.

## AI assistants (MCP)

The Worker serves a remote MCP server at `https://<your-app-host>/mcp`. In Claude, add it as a custom connector with that URL; other MCP clients take the same URL. The client registers itself, the person signs in with the same Google account (or is already signed in), and approves the assistant on a consent page at `/authorize`. From then on **the assistant acts as that person**: it sees only what they see, follows the same rules, and every change it makes is written to the task history with `task_events.via` set to the client's registered name (shown as "via Claude").

| Tool | What it does |
|---|---|
| `list_projects()` | Your projects: name, description, color, how each tracks effort (and whether it's required to finish), and who can be assigned there. The descriptions tell the assistant where tasks belong |
| `list_tasks(user?, project?, from?, to?, status?)` | Tasks by the day the app shows them on, with the same rollover rule (`shownOn`): "today" includes carried-over tasks. Defaults to today; at most 92 days |
| `create_task(title, project, due_date, assignee, priority, notes?, repeat?, effort?)` | All five main fields required. The tool description includes the project descriptions, so the assistant can pick the project without asking. `repeat` makes it a repeating task |
| `update_task(id, title?, notes?, project?, due_date?, priority?, status?, repeat?, stop_repeating?, skip?, effort?)` | Only the fields given change; `status: "open"` reopens; `effort` takes "1h 30m", "M" or "5" ("" clears it). On a repeating task, can change, stop or skip the repeat |
| `archive_task(id, restore?)` | Archives a task (hidden everywhere, nothing lost), or restores it |
| `complete_task(id, effort?)` | Marks it done today (with its effort, where the project needs it); for a repeating task, returns the new copy as `next_copy` |
| `list_comments(id)` | The task's comments, oldest first |
| `attach_file(id, name?, text \| base64 \| url)` | Attaches a file: text it writes, a small base64 file (≤ 2 MB), or a public https link the server downloads (≤ 25 MB; no local addresses) |
| `get_upload_url(id, name?)` | A one-time link (15 minutes) to POST a file to directly, e.g. `curl --data-binary @report.pdf` from an assistant that can run commands. Only a hash of the link is stored; it works once, as the person who asked, and stops working if they lose access |
| `read_attachment(id, file)` | Reads a text file attached to a task (up to 200 KB). Tasks list their `attachments` in every result |
| `update_checklist(id, add?, check?, uncheck?, remove?)` | Changes the task's checklist; items are referred to by id or exact text. Tasks show their `checklist` in every result |
| `add_comment(id, text)` | Posts a comment as the user, marked "via <assistant>" |
| `follow_task(id, follow?, person?)` | Follow a task (or stop); `person` adds or removes someone else on the project |
| `transfer_task(id, to, note?, this_only?)` | The new assignee must be on the task's project. `this_only` leaves future copies of a repeating task with the current person |
| `project_day(project, date)` | What got finished in a project that day (by priority, then due date), plus what's still open |

People and projects are given by name (or email, or "me"), not ids. Access is checked on every call, so disabling someone, taking them off a project or archiving a project applies to their assistant at once. Access tokens last an hour; a connection lasts a year from approval, after which the person signs in again. Disabling a person cuts their assistant off immediately.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:reset:local     # creates the local D1 database and loads the sample data
npm run dev                # http://localhost:5173
```

Open http://localhost:5173/login and use **Local development sign-in**, for example `jordan@example.com` (admin) or `sara@example.com` (member). This route only works when `DEV_LOGIN=1` is set and the request comes from localhost. Google isn't needed locally unless you want to try the real sign-in.

Useful commands: `npm run typecheck` · `npm run build` · `npm run db:migrate:local`. Local development uses `wrangler.jsonc` as it is (placeholder IDs, data under `.wrangler/state`); it doesn't need a `tenants/` file.

**Trying the MCP server locally.** With `npm run dev` running, start the MCP Inspector with `npx @modelcontextprotocol/inspector`, choose *Streamable HTTP*, enter `http://localhost:5173/mcp` and connect. It opens the consent page; if you aren't signed in, use the local development sign-in there and you'll come back to it. Changes made through the Inspector show up in the app's history as "via MCP Inspector" (or whatever name the client registered with). Local OAuth data lives in the local KV under `.wrangler/state`.

## Deploy to Cloudflare

The same code deploys to as many **instances** as you like, for example one per team or client. Each instance is its own Worker with its own database, so teams never see each other's data.

What makes an instance is a small file, `tenants/<instance>.env`, which is **not committed** (`.gitignore` keeps everything in `tenants/` out except `tenants/example.env`). `wrangler.jsonc` holds only what every instance shares, plus placeholder IDs for local development, so a plain `wrangler deploy` fails rather than deploying somewhere by accident.

| Value in `tenants/<instance>.env` | What it is | Where to get it |
|---|---|---|
| `WORKER_NAME` | The Worker; the app lives at `https://<WORKER_NAME>.<your-subdomain>.workers.dev` | You choose it (lowercase, numbers, dashes). Your subdomain is under *Workers & Pages* in the dashboard |
| `D1_DATABASE_NAME`, `D1_DATABASE_ID` | The instance's database | Printed by `npx wrangler d1 create <name>`; for an existing one, `npx wrangler d1 list` |
| `OAUTH_KV_ID` | Where AI assistant sign-ins are stored | Printed by `npx wrangler kv namespace create <name>`; for an existing one, `npx wrangler kv namespace list` |
| `TEAM_TZ` (optional) | Fallback time zone, e.g. `Europe/London` | Any "TZ identifier" from the [tz database list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) |
| `CUSTOM_DOMAINS` (optional) | e.g. `tasks.acme.com` | A domain (zone) in the same Cloudflare account |
| `WORKERS_DEV` (optional) | `false` to serve only on the custom domains | |
| `CLOUDFLARE_ACCOUNT_ID` (optional) | Needed when your login can reach several accounts | `npx wrangler whoami` |
| `R2_BUCKET` (optional) | Storage for attachments; empty turns attachments off | Printed by `npx wrangler r2 bucket create <name>` (R2 must be turned on for the account first: Dashboard → R2) |
| `CLOUDFLARE_PROFILE` (optional) | A different Cloudflare login for this instance (e.g. a client's own account) | Create one with `npx wrangler auth create <name>`; list them with `npx wrangler auth list` |

[`tenants/example.env`](tenants/example.env) explains each value in more detail. Secrets (the Google client) are never in the file: they're stored encrypted in Cloudflare, per Worker.

### A new instance

1. **Sign in to Cloudflare:** `npx wrangler login`
2. **Create its database and KV namespace, and the file:**
   ```bash
   npm run tenant -- create acme --tz Europe/London
   ```
   This creates the D1 database `taskivities-acme`, the KV namespace `taskivities-acme-oauth` and, if R2 is turned on for the account, the bucket `taskivities-acme-files`, and writes `tenants/acme.env` with their IDs. Options: `--name <worker-name>` (default `taskivities-<instance>`), `--domain tasks.acme.com`, `--account <account id>`, `--profile <login profile>` (to create them in an account under another Cloudflare login).
   (Or create them yourself as the table above says, copy `tenants/example.env` to `tenants/acme.env` and fill it in.)
3. **Create a Google OAuth client** at [console.cloud.google.com](https://console.cloud.google.com): *APIs & Services → Credentials → Create credentials → OAuth client ID*.
   - Type: **Web application**.
   - Authorized redirect URIs: `https://<WORKER_NAME>.<your-subdomain>.workers.dev/auth/callback` (and `https://<custom domain>/auth/callback` for each custom domain), plus `http://localhost:5173/auth/callback` if you also use it locally.
   - Consent screen: *Internal* if everyone is in your Google Workspace. Otherwise use *External* and publish it, since external people such as clients are added by email. Scopes: `openid`, `email`, `profile`.
   - One client can serve several instances: add each instance's redirect URI to it.
   - **Optional, for invite emails:** in the same project, enable the **Gmail API** (*APIs & Services → Library → Gmail API → Enable*) and add the scope `https://www.googleapis.com/auth/gmail.send` on the consent screen (*Data access → Add or remove scopes*). Only that one: the app never asks for `gmail.readonly`. With an *Internal* consent screen there's nothing else to do. With *External*, `gmail.send` is a "sensitive" scope: until Google verifies the app, admins see an "unverified app" warning when connecting, and while the app is in *Testing* Google expires the connection after 7 days (the app then falls back to the link until they reconnect). Skip this and everything else works; invites are shared as a link.
4. **Add the secrets** (you paste each value when asked):
   ```bash
   npm run tenant -- secret acme GOOGLE_CLIENT_ID
   ```
   ```bash
   npm run tenant -- secret acme GOOGLE_CLIENT_SECRET
   ```
   Optional: `ADMIN_EMAILS` (comma-separated addresses that are always let in as admins).
   - **Optional: sign-in without Google** (see below): `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`.
5. **Deploy:**
   ```bash
   npm run deploy -- acme
   ```
   This creates or updates the database tables, builds the app, and deploys it to that instance's Worker. The MCP Durable Object and custom domains are set up on the first deploy.
6. **Sign in right away:** on an empty install the first person to sign in becomes the admin. Add your team on the **People & projects** page, and upload your logo on the **Settings** page.
7. **Connect an assistant:** in Claude, add a custom connector with `https://<your-app-host>/mcp` and sign in. Nothing else to configure: assistants sign in through the same Google client.

### Sign-in without Google (optional, WorkOS)

Google sign-in works for any address with a Google account, including work addresses that aren't Gmail (people can make one at Google for their existing email). For people who don't want one, an instance can add a **Continue with email** button, run by [WorkOS AuthKit](https://workos.com/authkit): its hosted page sends a sign-in code by email, and can also offer Microsoft, passkeys or other methods you turn on there. WorkOS's free tier covers this (check [their pricing](https://workos.com/pricing)).

Nothing else changes: WorkOS only proves the email address. The address still has to be on the People & projects page (the first sign-in on an empty install still becomes the admin), roles and projects work the same, and assistants connecting over MCP can sign in either way. Taskivities keeps its own 30-day session and ends the WorkOS session at once, so signing out here signs out, and the next sign-in asks again.

1. Create an account at [dashboard.workos.com](https://dashboard.workos.com). Use the **Production** environment for live instances (Staging is for `http://localhost`).
2. **Authentication:** turn on the methods to offer, for example **Magic Auth** (emailed codes), **Microsoft OAuth** and **Passkeys**. Google can stay off there: the app has its own Google button.
3. **Redirects:** add `https://<your-app-host>/auth/workos/callback` for each instance (and `http://localhost:5173/auth/workos/callback` in Staging for local development). Set the **sign-in endpoint** (where AuthKit sends people to start a sign-in) to `https://<your-app-host>/auth/workos`.
4. **API Keys:** copy the **Client ID** (`client_…`) and the **API key** (`sk_…`) into the instance:
   ```bash
   npm run tenant -- secret acme WORKOS_CLIENT_ID
   ```
   ```bash
   npm run tenant -- secret acme WORKOS_API_KEY
   ```
5. Deploy. The sign-in page shows **Continue with email** whenever both are set; without them it shows Google only. An instance can also run on WorkOS alone, without the Google secrets (invite emails through Gmail then aren't available).

One WorkOS environment can serve several instances: add each one's redirect URI.

### Updates

Each build knows its version (`package.json`) and commit. Admins see **Update available** in the account menu (and a dot on their avatar) when a newer release is published on GitHub; the panel links to the release notes and shows the commands to update:

```bash
git pull
npm install
npm run deploy -- <instance>
```

The admin's browser checks [the releases](https://github.com/taskivities/taskivities-app/releases) at most every 6 hours (`src/updates.ts`): the Worker can't, because Workers share outgoing addresses and GitHub limits unauthenticated requests per address. Nothing about the team is sent. Members never see it. To follow your own fork's releases instead, set `UPDATE_REPO=owner/repo` in `tenants/<instance>.env`; `UPDATE_REPO=off` turns the notice off (the demo has it off).

**Publishing a release** (maintainers): what changed is collected under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) as it's built (see [AGENTS.md](AGENTS.md)). `npm version minor` (or `patch`/`major`) refuses to run if that section is empty; otherwise it bumps the version, turns Unreleased into the new version's section, commits and tags it. `git push --follow-tags` pushes both, and the Release workflow (`.github/workflows/release.yml`) publishes the GitHub release with that section as its notes (or notes generated from the commits, if it has none). Instances show the notice within 6 hours (as soon as an admin opens the app after that).

### Day to day

| Command | Does |
|---|---|
| `npm run deploy -- <instance>` | Migrate the database, build, deploy. Add `--dry-run` to build and check without deploying |
| `npm run tenant -- list` | Lists the instances in `tenants/` |
| `npm run db:migrate:remote -- <instance>` | Only the database migrations |
| `npm run tenant -- secret <instance> <NAME>` | Sets a secret on that instance's Worker |
| `npm run tenant -- wrangler <instance> <args…>` | Any other wrangler command for that instance, e.g. `tail` for live logs |

With a single file in `tenants/`, the instance name can be left out. `TENANT=acme npm run deploy` works too. The script writes each instance's full config to `.wrangler/tenants/<instance>.json` (git-ignored) and runs everything against it; see `scripts/tenant.mjs`.

Deploying to every instance after a code change is one command per instance; the database migrations run first each time, so instances can't end up on a newer app with an older database.

`DEV_LOGIN` is never set in production, so the development sign-in route returns 404 there.

**A public demo** anyone can try (sample sign-in, hourly reset, uploads kept as sample files) lives in [`demo/`](demo/README.md): a separate Worker that wraps this one, deployed with `node demo/deploy.mjs <instance>`.

## Not built yet

- **A list of connected assistants** in the app, with a way to disconnect them. For now a connection ends after a year, when the person is disabled, or when an admin deletes its grant from the `OAUTH_KV` namespace.
- **Automated tests.** So far everything has been checked by hand in the browser and with the API.

## License

[MIT](LICENSE) © 2026 Yusuf Bhabhrawala
