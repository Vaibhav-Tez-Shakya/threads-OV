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

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id
    ON thread_messages(thread_id);

CREATE INDEX IF NOT EXISTS idx_thread_messages_created_at
    ON thread_messages(created_at);
