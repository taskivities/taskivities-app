-- Estimates: a project that tracks effort can also ask for an estimate on its tasks, in the same measure
-- (shared/effort.ts): the time a task should take, or its expected size or points. Optional on every task.
--   projects.estimate: 1 if the project's tasks can carry an estimate (only meaningful while projects.effort is set)
--   tasks.estimate:    NULL, or '<type>:<value>' like tasks.effort ('time:120', 'tshirt:M', 'fibo:5')
ALTER TABLE projects ADD COLUMN estimate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN estimate TEXT;
