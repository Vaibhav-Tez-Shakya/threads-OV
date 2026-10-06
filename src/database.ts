import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
});

export interface Thread {
  id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ThreadMessage {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: Date;
}

export async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS threads (
      id UUID PRIMARY KEY,
      title TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS thread_messages (
      id UUID PRIMARY KEY,
      thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id_created_at
      ON thread_messages(thread_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_threads_updated_at
      ON threads(updated_at DESC);
  `);

  console.error("Database schema initialized successfully.");
}
export async function testDatabaseConnection(): Promise<void> {
  const result = await pool.query(
    "SELECT current_database(), current_user, version()",
  );

  console.error("PostgreSQL connection successful:");
  console.error(result.rows[0]);
}

export async function createThread(
  id: string,
  title?: string,
): Promise<Thread> {
  const result = await pool.query<Thread>(
    `
      INSERT INTO threads (id, title)
      VALUES ($1, $2)
      RETURNING id, title, created_at, updated_at
    `,
    [id, title ?? null],
  );

  return result.rows[0];
}

export async function saveMessage(
  id: string,
  threadId: string,
  role: string,
  content: string,
): Promise<ThreadMessage> {
  const result = await pool.query<ThreadMessage>(
    `
      INSERT INTO thread_messages (id, thread_id, role, content)
      VALUES ($1, $2, $3, $4)
      RETURNING id, thread_id, role, content, created_at
    `,
    [id, threadId, role, content],
  );

  await pool.query(
    `
      UPDATE threads
      SET updated_at = NOW()
      WHERE id = $1
    `,
    [threadId],
  );

  return result.rows[0];
}

export async function getThread(
  threadId: string,
): Promise<{ thread: Thread; messages: ThreadMessage[] }> {
  const threadResult = await pool.query<Thread>(
    `
      SELECT id, title, created_at, updated_at
      FROM threads
      WHERE id = $1
    `,
    [threadId],
  );

  if (threadResult.rows.length === 0) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const messagesResult = await pool.query<ThreadMessage>(
    `
      SELECT id, thread_id, role, content, created_at
      FROM thread_messages
      WHERE thread_id = $1
      ORDER BY created_at ASC
    `,
    [threadId],
  );

  return {
    thread: threadResult.rows[0],
    messages: messagesResult.rows,
  };
}

export async function listThreads(): Promise<Thread[]> {
  const result = await pool.query<Thread>(
    `
      SELECT id, title, created_at, updated_at
      FROM threads
      ORDER BY updated_at DESC
    `,
  );

  return result.rows;
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

