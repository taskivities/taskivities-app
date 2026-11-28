-- Timer: a project that tracks effort as time spent can turn on active time tracking. Anyone who can edit a task
-- can then start and stop a timer on it; stopping adds the whole minutes it ran to the task's effort ('time:<min>')
-- and widens the task's span (due date / duration) to cover the days the time was spent.
--   projects.timer:         1 if the project's tasks have a timer (only while projects.effort = 'time')
--   tasks.timer_started_at: when the running timer started (ISO), or NULL when none is running
--   tasks.timer_by:         who started it
ALTER TABLE projects ADD COLUMN timer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN timer_started_at TEXT;
ALTER TABLE tasks ADD COLUMN timer_by TEXT;
