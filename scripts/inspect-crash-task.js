const Database = require('better-sqlite3');
const db = new Database('data/tasks.db', { readonly: true });

const task = db
  .prepare(
    `SELECT id, title, status, error_message, pipeline_phase, result_summary,
            started_at, finished_at, created_at, prompt_rendered
     FROM tasks WHERE id = '8b0caded-e949-4fd2-b06d-8b25d02342fe'`,
  )
  .get();

console.log('=== crash-window task ===');
console.log(
  JSON.stringify(
    {
      ...task,
      prompt_rendered: String(task?.prompt_rendered || '').slice(0, 800),
      result_summary: String(task?.result_summary || '').slice(0, 1500),
    },
    null,
    2,
  ),
);

const events = db
  .prepare(
    `SELECT type, created_at, substr(payload,1,600) AS payload
     FROM task_events
     WHERE task_id = ?
     ORDER BY id ASC`,
  )
  .all(task.id);

console.log('=== all events for that task ===');
for (const e of events) {
  let text = e.payload;
  try {
    const p = JSON.parse(e.payload);
    text = p.chunk || p.error || JSON.stringify(p);
  } catch {}
  console.log(`[${e.created_at}] ${e.type}: ${String(text).slice(0, 300)}`);
}

const concurrent = db
  .prepare(
    `SELECT id, title, status, started_at, finished_at
     FROM tasks
     WHERE started_at <= '2026-07-18T08:05:10'
       AND (finished_at IS NULL OR finished_at >= '2026-07-18T08:04:50')
     ORDER BY started_at`,
  )
  .all();
console.log('\n=== concurrent tasks at crash ===');
console.log(JSON.stringify(concurrent, null, 2));

db.close();
