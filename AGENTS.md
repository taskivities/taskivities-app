# Working on Taskivities

Instructions for AI coding agents (and people) changing this repository. The [README](README.md) explains what the
app does and how it's built; read the parts you're touching.

## Every feature change and bug fix goes in CHANGELOG.md

When you add a feature, change how something behaves, or fix a bug that someone could notice, add a line to
[CHANGELOG.md](CHANGELOG.md) under `## Unreleased`, in the same change.

- Put it under `### Added`, `### Changed`, `### Fixed` or `### Removed` (create the heading if it isn't there yet).
- One bullet per change, written for the people who run Taskivities and use it, not for developers: what they'll
  notice, in plain words. Start with the area in bold, e.g. `- **Projects:** archived projects can be restored from the Team page.`
- Mention anything an admin has to do when they update (a new secret, a setting, a one-off step). Database
  migrations run on deploy, so they need no note unless they change existing data in a way people will see.
- Skip changes nobody would notice (refactors, comments, tests, internal tooling) unless they change how the app
  is set up or deployed.
- Never edit a section that's already released (`## vX.Y.Z`), and don't change the version in `package.json`:
  releasing does that (see below).

## Releasing (maintainers)

1. Check `## Unreleased` in CHANGELOG.md says everything that changed.
2. `npm version minor` (new features), `npm version patch` (fixes only) or `npm version major`. It refuses to run if
   Unreleased is empty; otherwise it bumps `package.json`, turns Unreleased into `## vX.Y.Z (date)`, commits, and tags.
3. `git push --follow-tags`. The Release workflow publishes the GitHub release with that section as its notes, and
   every instance's admins see "Update available" within a few hours.

## Checks before you finish

```bash
npm run typecheck                             # the app and the Worker
npm test                                      # unit tests in test/ (Node's built-in runner, no install)
npx tsc -p demo/tsconfig.json --noEmit        # the public demo, which wraps the Worker
```

Try changes in the running app (`npm run dev`, then sign in at http://localhost:5173/login with the local sign-in,
e.g. `jordan@example.com` as an admin or `sara@example.com` as a member).

## Conventions

- **Database:** add a new numbered file in `migrations/` (never edit one that has been applied anywhere). Deploys
  apply migrations before the new code goes live. `task_events` is append-only by design.
- **Nothing is deleted:** tasks and projects are archived, people are disabled, and every task change is written to
  its history.
- **Access:** members only see their projects; check it on the server for every route and MCP tool (see `visible()`
  and `canSeeProject()` in `worker/`).
- **Several instances in one app:** servers stay single-tenant; the app connects to other instances itself. Before
  touching `src/sources.ts`, `src/router.ts`, `worker/v1.ts`, `worker/relay.ts`, notifications, or any list of
  people or projects, read [docs/multi-instance.md](docs/multi-instance.md) and follow its rules (new routes on both
  `/api` and `/v1`, `clientFor(id)` for task requests, `localProjects` / `localUsers` for this instance's lists).
- **The demo** (`demo/`) wraps the app without changing it. Keep demo-only behaviour there, and update it if a
  change affects sign-in, uploads, settings or the reset.
- **Docs:** update the README when behaviour, setup or deployment changes.
- **Secrets:** never commit `.dev.vars` or `tenants/*.env`, and never print secret values. `DEV_LOGIN` is for local
  development only.
