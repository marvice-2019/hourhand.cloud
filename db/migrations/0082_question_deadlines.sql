-- Question deadlines (B21): the host is reminded a day before an open question is due, and a question still open a day
-- after it was due is closed for them: a paid one is refunded in full (through the same refund path as a decline), a
-- free one is closed, and the guest is told it wasn't answered in time.
alter table questions
  add column host_reminded_at timestamptz,  -- when the host was reminded the answer is due
  add column expired_at timestamptz;        -- set when the question was closed for missing its due date

create index questions_open_due_idx on questions (due_at) where status = 'open';
