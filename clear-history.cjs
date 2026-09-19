const path = require("path");
const Database = require("better-sqlite3");
const home = process.argv[2] || process.env.HOME;
const db = new Database(path.join(home, ".automaton", "state.db"));
const tables = [
  "turns", "tool_calls", "event_stream", "episodic_memory",
  "session_summaries", "semantic_memory", "knowledge_store",
  "working_memory", "procedural_memory", "relationship_memory",
];
const before = {}, after = {};
for (const t of tables) { try { before[t] = db.prepare("SELECT COUNT(*) n FROM " + t).get().n; } catch { before[t] = "n/a"; } }
db.transaction(() => {
  for (const t of tables) { try { db.prepare("DELETE FROM " + t).run(); } catch {} }
  // Clear turn-count / session cursors so the next boot is a clean "first run".
  db.prepare("DELETE FROM kv WHERE key IN ('session_id','start_time','sleep_until','blocked_goal_backoff','soul_content_hash','last_known_balance')").run();
})();
for (const t of tables) { try { after[t] = db.prepare("SELECT COUNT(*) n FROM " + t).get().n; } catch { after[t] = "n/a"; } }
db.close();
console.log("before:", JSON.stringify(before));
console.log("after: ", JSON.stringify(after));
