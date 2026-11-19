# Changelog

What changed in each version of Taskivities, newest first. Each version's section becomes its
[GitHub release](https://github.com/taskivities/taskivities-app/releases) notes, and admins of every instance see
"Update available" in the app's account menu when a new one is published.

New changes go under **Unreleased** (see [AGENTS.md](AGENTS.md)). `npm version minor` (or `patch`/`major`) turns that
section into the new version's; `git push --follow-tags` publishes it.

## Unreleased

## v0.14.0 (2026-11-19)

### Added

- **Sign-in:** people can sign in with a 6-digit code sent to their email, with no Google or Microsoft account. An
  admin turns it on under **Settings → Sign-in → Email codes** with a [Resend](https://resend.com) API key and a From
  address on a domain verified there.
- **Settings:** a new **Sign-in** section, where admins set up Google, Microsoft 365, WorkOS, email codes and the
  Google Drive and OneDrive keys in the app instead of as Worker secrets. It shows the exact redirect URIs to paste,
  and new Google, Microsoft or WorkOS settings are saved only after a test sign-in with them works, so a typo can't
  lock anyone out.
- **New instances:** `npm run tenant -- create` now writes a setup key (`TOKEN_KEY`) into `tenants/<instance>.env`,
  and that's the only secret a new instance needs. After the first deploy, open the app and enter your email and that
  key: you become the admin, and set up everything else in the app.

### Changed

- **Updating:** your next `npm run deploy` adds a `TOKEN_KEY` line to `tenants/<instance>.env` and sends it to the
  Worker. Keep that file private and never change the key: it encrypts the sign-in settings. Existing sign-in keeps
  working with nothing to re-enter: the secrets set before (`GOOGLE_CLIENT_ID`, `MS_CLIENT_SECRET`, …) are copied
  into **Settings → Sign-in** once, and are changed there from then on. Connected Gmail and Outlook invite mailboxes
  keep working too.
- **Sign-in:** on an instance with a setup key, the first person to sign in no longer becomes the admin by default;
  the admin is whoever sets the instance up with the key.

## v0.13.0 (2026-11-09)

### Added

- **Projects:** a new **Gantt** view (next to Today, Week and Board, or press V) charts a project's High-priority
  tasks over five weeks. Only High tasks are shown, so the chart stays readable. Each bar runs from the due date
  through the days the task lasts; overdue tasks run on to today in red, finished ones are faded, and arrows show
  which tasks wait on which, in red when the dates clash. Step through weeks with the arrows or [ and ], and click a
  task to open it. Drag a bar to move the task to other days, or drag its right edge to change how many days it lasts
  (with a mouse; Esc cancels, and Undo puts it back).

### Changed

- **AI assistants:** Claude and other assistants are now told what each priority is for. Asked to plan a project,
  they make its steps High-priority tasks (so they show on the Gantt chart) with how many days each lasts and what
  waits on what, keep smaller work at Normal, and keep Urgent for real emergencies. Reconnect the assistant, or
  start a new chat, to pick this up.

## v0.12.0 (2026-11-09)

### Added

- **Tasks:** a task can now last several days. Choose **Lasts** in the date picker (from the task, or while adding one):
  a task due Nov 1 that lasts 2 days isn't overdue until Nov 3. While it runs it sits in today without a "late" badge
  and shows "Day 2 of 3"; a repeating task's next copy lasts as long. Assistants can set it too (`duration_days`).

### Changed

- **Today:** carried-over tasks are no longer stacked at the top. They're mixed into today's tasks by priority (the
  oldest first among equals), each still marked "Nd late", in the Today list, the Week view, the Board's today column
  and Focus mode. A short **Carried over** bar above the list still counts them and has **Move all**.

### Fixed

- **Tasks:** a long title no longer hides the little badges after it (checklist, files, comments, effort, repeats,
  waiting on); the title is cut short instead, and hovering it shows the whole title.

## v0.11.2 (2026-11-08)

### Fixed

- **My day:** in focus mode, a task you open now covers the focus bar, so its Close button works again instead of
  sitting under "Exit focus".

## v0.11.1 (2026-11-08)

### Changed

- **Focus mode:** a task someone assigns you for today, or changes while you're focused, now glows for a moment as it arrives, so it doesn't slip in unnoticed.

## v0.11.0 (2026-11-08)

### Added

- **My day:** a new **Focus** button (or ⇧F) clears the screen down to just your tasks for today, carried-over ones first, with your progress for the day. Tick tasks off, open them or move them to another day without leaving it; **Exit focus**, Esc or the browser's Back button takes you back. Reloading the page keeps you in focus mode, and you can bookmark it.

## v0.10.0 (2026-11-08)

### Added

- **Attachments:** attach files from Google Drive or OneDrive / SharePoint, picked in their own file pickers. Attach a copy, kept here like any other file, or a link that always opens the latest version for people the file is shared with. Links work even on instances without file storage. Admins turn each drive on separately: see "Files from Google Drive and OneDrive" in the README (a Google API key and project number, or file permissions and a new redirect on the Microsoft app registration, then `MS_FILES=on`).
- **Attachments:** paste a link to attach any https address, such as a Google Doc, OneDrive file, Dropbox file or Figma design, on every instance, with no setup and even without file storage. It's named from the address unless you give it a name, and shows which site it's on. AI assistants can attach a link too, instead of downloading a copy.

## v0.9.0 (2026-11-08)

### Changed

- **Dark theme by default:** the app now opens in the dark theme. Anyone who prefers Light, or following their device's setting, can pick **Light** or **System** in the account menu; people who already picked Light or Dark keep their choice.
- **Faster edits:** adding a task, checklist items or a comment, linking or unlinking dependencies, removing a file and restoring an archived task now show on screen at once, without waiting for the server. A new task can be ticked, moved or opened straight away. The confirmation (**Done: …**, **Moved to …**) shows at once too. In the rare case the server refuses a change, it's undone on screen with a message saying why, and a task or comment that wasn't added goes back in its box so nothing typed is lost.
- **Other instances:** after approving the connection on the other instance, **Other instances** opens straight away and shows it connecting, instead of opening only once everything there had loaded. Its tasks show as soon as they've loaded.

## v0.8.0 (2026-11-07)

### Added

- **Dependencies between tasks:** a task can wait on other tasks, as many as it needs, and one task can block several. Add them from a task's panel (**Add dependency**, or ⋯ → **Dependencies…**), picking tasks this one waits on or tasks waiting on it; tasks in other projects work too. Rows and cards show **Waiting on 2** or **Blocks 1**, in red when the dates don't work: a waiting task that's late or due before what it waits on, and **Holding up 1** on the task in the way. Nothing moves on its own: moving a task past the ones waiting on it offers **Move it too**, and the task panel offers to move a waiting task to when its blockers are due. Whoever has a waiting task is notified when the last thing it waits on is done. Assistants can set dependencies too (`set_dependencies`), and see them on every task.

## v0.7.0 (2026-11-07)

### Added

- **AI assistants can manage projects and invite people:** admins can ask Claude (or another assistant) to create a project, rename it, change its description, colour or effort tracking, add or remove members, archive or restore it, and invite people by email (`create_project`, `update_project`, `archive_project`, `invite_people`). The same rules apply as on the People & projects page.
- **Invite emails from Outlook:** admins on instances with Microsoft 365 sign-in can connect their Outlook on the Settings page, and invites are emailed from their own address, as with Gmail. Add the delegated **Mail.Send** and **offline_access** Microsoft Graph permissions to the Entra app first (see the README). Each admin connects one mailbox, Gmail or Outlook; existing Gmail connections carry over.

### Fixed

- **Invite wording:** invite emails, the sign-in link and the People & projects page no longer say "Sign in with Google" on instances that offer Microsoft or email sign-in; they name the ways people can sign in there.

## v0.6.1 (2026-11-07)

### Changed

- **Switcher:** with other instances connected, the instance buttons at the top stay on one line, with each instance's colour, and scroll sideways when there are many.
- **Demo:** apps that connect the public demo (Other instances) show it as **Taskivities Demo**, so its tasks and people stand apart from your own instance's. The demo itself looks the same.

## v0.6.0 (2026-11-07)

### Added

- **Other instances:** use one app for all your Taskivities instances. In the account menu, open **Other instances**, give another instance's address and approve there (you sign in to it as usual). Your tasks there then show in your day, week and board, labelled with where they're from, and you can do anything with them you could there, from done and dates to comments, files and handing over. Their inbox entries show under the bell, and their notifications reach your devices through this instance. The switcher lists each connected instance's people and projects too, so you can open anyone's week or any project there, tick several across instances, and add tasks there from the quick-add. Each device connects once; a new one offers your instances in one tap. Both instances need this version. You can try it with the public demo: connect `demo.taskivities.com` and pick a sample person (the demo doesn't send its notifications to other instances).
- **Back, Forward and links:** the address bar now follows what you're looking at: someone's week, a project, several at once, the view and week, and the task you have open. Use the browser's Back and Forward buttons, bookmark a view, or share a link to a task.
- **Sign in with Microsoft 365:** the sign-in page can offer **Continue with Microsoft** for your organization's own Microsoft 365 (Entra ID) accounts, next to or instead of Google and email sign-in. Only accounts in your organization, and guests it has invited, can use it, and as with Google they still have to be added on the People & projects page. To turn it on, register an app in Microsoft Entra and set the `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and `MS_TENANT_ID` secrets (see the README). Entra client secrets expire, so note the date and replace it before then.

### Changed

- **Demo:** the public demo now resets every 8 hours (at 00:00, 08:00 and 16:00 UTC) instead of every hour.

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
