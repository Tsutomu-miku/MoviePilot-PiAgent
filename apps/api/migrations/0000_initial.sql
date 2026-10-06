CREATE TABLE conversations (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  automatic_title INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  session_file TEXT,
  PRIMARY KEY (user_id, id)
);
--> statement-breakpoint
CREATE TABLE requests (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  reply TEXT,
  PRIMARY KEY (user_id, id)
);
--> statement-breakpoint
CREATE TABLE messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  views TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX message_conversation ON messages (user_id, conversation_id, sequence);
--> statement-breakpoint
CREATE TABLE preferences (
  user_id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  source TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE conversation_states (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  catalog TEXT NOT NULL,
  search TEXT,
  PRIMARY KEY (user_id, conversation_id)
);
--> statement-breakpoint
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL,
  value TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX task_state ON tasks (state);
--> statement-breakpoint
CREATE TABLE ui_bindings (
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  PRIMARY KEY (user_id, endpoint)
);
--> statement-breakpoint
CREATE TABLE feishu_routes (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);
