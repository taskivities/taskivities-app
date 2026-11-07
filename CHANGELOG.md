# Changelog

What changed in each version of Taskivities, newest first. Each version's section becomes its
[GitHub release](https://github.com/taskivities/taskivities-app/releases) notes, and admins of every instance see
"Update available" in the app's account menu when a new one is published.

New changes go under **Unreleased** (see [AGENTS.md](AGENTS.md)). `npm version minor` (or `patch`/`major`) turns that
section into the new version's; `git push --follow-tags` publishes it.

## Unreleased

### Added

- **Sign in with Microsoft 365:** the sign-in page can offer **Continue with Microsoft** for your organization's own Microsoft 365 (Entra ID) accounts, next to or instead of Google and email sign-in. Only accounts in your organization, and guests it has invited, can use it, and as with Google they still have to be added on the People & projects page. To turn it on, register an app in Microsoft Entra and set the `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and `MS_TENANT_ID` secrets (see the README). Entra client secrets expire, so note the date and replace it before then.
- **Invite emails from Outlook:** on an instance with Microsoft sign-in, admins can connect their Outlook on the Settings page, and invites are emailed from their own Microsoft 365 mailbox, just as they can be from Gmail. The app asks Microsoft only for permission to send mail, never to read it. Add the `Mail.Send` and `offline_access` permissions to the Entra app first (see the README).

### Fixed

- Invite emails, the People & projects page and the copied-link message said to "sign in with Google" even on instances without Google sign-in. They now name the instance's own sign-in methods.

## v0.5.2 (2026-11-06)

- **Empty days are hidden:** in Week views, days with nothing done or planned are no longer shown, so the list is shorter. Today always shows. A week with nothing at all says so.

## v0.5.1 (2026-11-06)

- **Copy what got done:** each task now says the day it was done (left out when the copy covers a single day) and, in views of several people or a project, the initials of whoever ticked it. A person's copy is titled with their initials.
- **Simpler summary:** the line under a person's or project's name no longer repeats the carried-over count; the open count already includes them, and the Carried over block below still lists them.
- **Stress-test data (for developers):** `npm run db:stress:local` loads about 1,000 tasks for 24 people over two and a half months, with notes, comments, checklists, attachments, followers and effort, relative to today (`scripts/stress-seed.mjs`).

## v0.5.0 (2026-11-06)

- **See several people or projects together:** turn on **Several** in the switcher and tick people and projects. Several people show all their tasks together; several projects show those projects together; people and projects together show those people's tasks in those projects. Today, Week and Board all work with it, each tick changes the view at once, and it's remembered after a reload. Ticking just one person or one project goes back to their usual view.
- **Copy what got done:** a copy button next to the week controls copies every task done in the days shown as one Markdown list, with the total effort where projects track it. It works for your week, anyone's, a project's, and several people or projects together.

## v0.4.0 (2026-11-06)

- **Effort:** a project can now track effort on its tasks, as **time spent** (like 1h 30m), **T-shirt sizes** (XS–XL) or **story points** (1–21), chosen in the project's editor. It can be required before a task is marked done: ticking it asks for the effort first. Set it in the task panel; it shows as a small badge on the task. A project's day report, Copy summary and week show totals ("1 done · 1h 30m", "13 pts planned"). Assistants can read and set it too (`effort` on `create_task`, `update_task` and `complete_task`).
- **Board, more than a week:** show as many weeks as you like on the Board, side by side, and scroll sideways. Use − / + above it or the *Next week* column at its end. Drag a card near the edge and the board scrolls with you, so you can move a task from Friday to next Tuesday, or weeks ahead. The Board remembers how many weeks you chose on each device.
- **Empty days fold to one row:** in a week, a coming day with nothing planned is a single dashed row instead of a heading and an empty box. Click it to add a task on that day.
- **Safari:** changing the project (or date, priority, assignee) in a new task before typing its title no longer closes the form.

## v0.3.2 (2026-11-06)

- **People and projects on one screen:** there's no separate Projects page anymore. Pick a person or a project from the switcher at the top of the page; everything a project's view had (the day report, Not finished, Archived) is still there. The logo and **G T** go to your week, and **G P** to the project you last looked at, even after a reload. The ⋯ menu next to the logo is now just People & projects and Settings, for admins.
- **Project boards use the full width,** like a person's board.
- **Team is now People & projects:** the admin page for managing people and projects has a name that says both, at `/manage` (the old `/team` still works). People and projects are on two tabs (People at `/manage`, Projects at `/manage/projects`), each with its own button: **Add people** or **New project**. **G U** still goes there.
- **Phones:** opening the switcher (or any menu with a search box) no longer pops up the keyboard and closes itself. Tap the search box to type; the list fits above the keyboard.

## v0.3.1 (2026-11-06)

- **One switcher for people and projects:** the same list on Tasks and Projects, with people first on Tasks and projects first on Projects. It has a search box, jump buttons for big teams, and it scrolls instead of running off the screen, so the second section is always reachable.
- **Open by default when looking at someone else's work:** in another person's week and in a project's week every past day with something in it starts open (empty days stay folded), and a project's "Not finished" list starts open and stays that way when you switch projects. Your own week still folds past days away to keep it clean.

## v0.3.0 (2026-11-05)

- **Inbox:** a bell in the top bar lists what needs you: tasks given to you, comments on your tasks, and handovers, with a count of what's new. It works whether or not notifications are on, and on every device. It's read from the task history, so nothing extra is stored. **G I** opens it.
- **Followers:** follow a task to hear about its comments, when it's done or reopened, and when it's handed on, in notifications and the inbox. Creators follow their tasks, commenting follows a task, and you can add someone else on the project. **F** follows the selected task; assistants can use `follow_task`.

## v0.2.0 (2026-11-05)

The first published release: everything Taskivities does so far.

### Added
- **Tasks:** Today, Week and Board views of anyone's work you can see, with carried-over tasks, priorities, due dates, transfers with a note, and drag-and-drop on the board. Everything is keyboard-driven (press `?` for the shortcuts).
- **Projects:** the same Today, Week and Board views for a project, showing everyone's tasks in it, plus the day report with Copy summary. The picker at the top lists people and projects together, so switching keeps the same view.
- **Repeating tasks**, **comments**, **checklists** and **file attachments** (with an R2 bucket), all recorded in each task's permanent history.
- **Archive instead of delete** for tasks and projects: they leave every list and can be restored with their history.
- **People:** admins add people by email with a role and projects, and disable them instead of deleting them; disabled people keep their history and can be enabled again.
- **Sign-in** with Google, and optionally with an emailed code, Microsoft or passkeys through WorkOS AuthKit.
- **Invite emails** sent from an admin's own Gmail (send-only permission).
- **Notifications** on phones and computers (Web Push): tasks given to you, comments on your tasks, and an optional 8:00 summary. No outside service; keys are created on the first deploy.
- **AI assistants** connect over MCP (for example Claude) and act as the person who connected them, with every change marked in the history.
- **Webhooks** that turn requests from other services into tasks.
- **Branding:** your own logo, name or wordmark, and home-screen icon. Light and dark themes. Installs to a phone's home screen.
- **Update notices:** admins see "Update available" when a newer release is published, with the release notes and the commands to update.
- **Deploy many teams** from one codebase (`npm run tenant`, `npm run deploy`), and a public demo (`demo/`).
