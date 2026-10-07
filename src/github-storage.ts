import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

const GITHUB_API_BASE = "https://api.github.com";

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const owner = requiredEnv("GITHUB_OWNER");
const repo = requiredEnv("GITHUB_REPO");
const branch = process.env.GITHUB_BRANCH ?? "main";
const threadsPath = process.env.GITHUB_THREADS_PATH ?? "threads";
const token = requiredEnv("GITHUB_TOKEN");

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

interface StoredThread {
  thread: Thread;
  messages: ThreadMessage[];
}

interface GitHubFile {
  sha: string;
  content?: string;
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rateLimitRemaining?: string,
    readonly rateLimitReset?: string,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 404;
}

function isTransientServerError(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && [500, 502, 503, 504].includes(error.status);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function headers(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

const conversationsPath = `${threadsPath}/conversations`;
const documentsPath = `${threadsPath}/documents`;

function safeMarkdownName(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const safe = cleaned.replace(/^\.+$/, "").slice(0, 120).trim();
  return safe || fallback;
}

function legacyThreadFilePath(threadId: string): string {
  return `${threadsPath}/${threadId}.md`;
}

async function listMarkdownFiles(folderPath: string): Promise<Array<{ name: string; path: string; sha: string }>> {
  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/contents/${encodePath(folderPath)}?ref=${encodeURIComponent(branch)}`;
  const files = await githubRequest<Array<{ name: string; path: string; sha: string; type: string }>>(url);
  return files.filter((file) => file.type === "file" && file.name.toLowerCase().endsWith(".md"));
}

async function findThreadFile(threadId: string): Promise<string> {
  try {
    const candidates = await listMarkdownFiles(conversationsPath);
    for (const candidate of candidates) {
      const { markdown } = await getFile(candidate.path);
      const storedId = markdown.match(/^- Thread ID: (.+)$/m)?.[1]?.trim();
      if (storedId === threadId) return candidate.path;
    }
  } catch (error) {
    // An absent conversations directory is expected before the first new save.
    if (!(error instanceof Error) || !error.message.includes("GitHub API request failed (404)")) throw error;
  }

  const legacyPath = legacyThreadFilePath(threadId);
  try {
    const { markdown } = await getFile(legacyPath);
    const storedId = markdown.match(/^- Thread ID: (.+)$/m)?.[1]?.trim();
    if (storedId === threadId) return legacyPath;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("GitHub API request failed (404)")) throw error;
  }
  throw new Error(`Thread not found: ${threadId}`);
}

async function githubRequest<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const isRead = (options.method ?? "GET").toUpperCase() === "GET";
  const maxReadAttempts = 3;

  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          ...headers(),
          ...(options.headers ?? {}),
        },
      });
    } catch (error) {
      if (isRead && attempt < maxReadAttempts) {
        await wait(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`GitHub API network request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const body = await response.text();
    const remaining = response.headers.get("x-ratelimit-remaining") ?? undefined;
    const reset = response.headers.get("x-ratelimit-reset") ?? undefined;
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (remaining === "0" || /rate limit|secondary rate limit/i.test(body)));
    const resetTime = reset && Number.isFinite(Number(reset))
      ? new Date(Number(reset) * 1000).toISOString()
      : undefined;
    const resetDescription = resetTime
      ? ` Rate limit resets at ${resetTime}.`
      : "";
    const retryDescription = retryAfter
      ? ` Retry after ${retryAfter} seconds.`
      : "";
    const headerDetails = [
      remaining ? `x-ratelimit-remaining=${remaining}` : undefined,
      reset ? `x-ratelimit-reset=${reset}` : undefined,
      retryAfter ? `retry-after=${retryAfter}` : undefined,
    ].filter(Boolean).join(", ");
    const statusText = body || response.statusText || "No response body";
    const diagnostic = rateLimited
      ? ` GitHub rate limit reached.${retryDescription}${resetDescription}`
      : "";
    const apiError = new GitHubApiError(
      response.status,
      `GitHub API request failed (${response.status}): ${statusText}.${diagnostic}${headerDetails ? ` Response headers: ${headerDetails}.` : ""}`,
      remaining,
      reset,
      retryAfter,
    );

    // GETs are safe to retry. Writes are reconciled by putFile so a request
    // that succeeded despite a 5xx response cannot create duplicate commits.
    if (isRead && isTransientServerError(apiError) && attempt < maxReadAttempts) {
      await wait(500 * 2 ** (attempt - 1));
      continue;
    }
    throw apiError;
  }
}

function encodePath(pathValue: string): string {
  return pathValue
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function formatDate(date: Date): string {
  return date.toISOString();
}

function renderMarkdown(
  thread: Thread,
  messages: ThreadMessage[],
): string {
  const sections = [
    `# ${thread.title ?? "Untitled Thread"}`,
    "",
    `- Thread ID: ${thread.id}`,
    `- Created: ${formatDate(thread.created_at)}`,
    `- Updated: ${formatDate(thread.updated_at)}`,
    "",
    "---",
    "",
  ];

  for (const message of messages) {
    const roleLabel =
      message.role.toLowerCase() === "assistant" ||
      message.role.toLowerCase() === "claude"
        ? "Claude"
        : message.role.charAt(0).toUpperCase() + message.role.slice(1);

    sections.push(
      `## ${roleLabel}`,
      "",
      message.content,
      "",
      "---",
      "",
    );
  }

  return sections.join("\n");
}

function parseMarkdown(markdown: string, threadId: string): StoredThread {
  const lines = markdown.split(/\r?\n/);

  const titleLine = lines.find((line) => line.startsWith("# "));
  const idLine = lines.find((line) => line.startsWith("- Thread ID: "));
  const createdLine = lines.find((line) => line.startsWith("- Created: "));
  const updatedLine = lines.find((line) => line.startsWith("- Updated: "));

  const id = idLine?.replace("- Thread ID: ", "").trim() ?? threadId;

  const createdAtValue =
    createdLine?.replace("- Created: ", "").trim() ?? new Date().toISOString();

  const updatedAtValue =
    updatedLine?.replace("- Updated: ", "").trim() ?? createdAtValue;

  const thread: Thread = {
    id,
    title: titleLine?.replace("# ", "").trim() || null,
    created_at: new Date(createdAtValue),
    updated_at: new Date(updatedAtValue),
  };

  const messages: ThreadMessage[] = [];

  let currentRole: string | null = null;
  let currentContent: string[] = [];
  let messageIndex = 0;

  const flushMessage = () => {
    if (!currentRole) {
      return;
    }

    const content = currentContent.join("\n").trimEnd();

    if (content.length === 0) {
      currentRole = null;
      currentContent = [];
      return;
    }

    messages.push({
      id: `${thread.id}-${messageIndex++}`,
      thread_id: thread.id,
      role: currentRole === "Claude" ? "assistant" : currentRole.toLowerCase(),
      content,
      created_at: new Date(thread.created_at.getTime() + messageIndex),
    });

    currentRole = null;
    currentContent = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushMessage();
      currentRole = line.slice(3).trim();
      continue;
    }

    if (currentRole) {
      if (line.trim() === "---") {
        flushMessage();
        continue;
      }

      currentContent.push(line);
    }
  }

  flushMessage();

  return {
    thread,
    messages,
  };
}

async function getFile(
  filePath: string,
): Promise<{ file: GitHubFile; markdown: string }> {
  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/contents/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`;

  const file = await githubRequest<GitHubFile>(url);

  if (!file.content) {
    throw new Error(`GitHub file has no content: ${filePath}`);
  }

  const markdown = Buffer.from(
    file.content.replace(/\n/g, ""),
    "base64",
  ).toString("utf8");

  return {
    file,
    markdown,
  };
}

async function putFile(
  filePath: string,
  content: string,
  message: string,
  sha?: string,
): Promise<void> {
  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/contents/${encodePath(filePath)}`;

  const body: Record<string, string> = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
  };

  let expectedSha = sha;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (expectedSha) body.sha = expectedSha;
    else delete body.sha;

    try {
      await githubRequest(url, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return;
    } catch (error) {
      if (!isTransientServerError(error)) throw error;

      // A 5xx can arrive after GitHub committed the write. Read the file
      // before retrying to avoid duplicate or conflicting content writes.
      await wait(1000 * attempt);
      let current: { file: GitHubFile; markdown: string } | undefined;
      try {
        current = await getFile(filePath);
      } catch (readError) {
        if (!isNotFound(readError)) {
          throw new Error(`${error.message} Could not verify whether the write completed: ${readError instanceof Error ? readError.message : String(readError)}`);
        }
      }

      if (current?.markdown === content) return;
      if (current && (!expectedSha || current.file.sha !== expectedSha)) {
        throw new Error(`${error.message} The file changed while the write was being checked; no retry was attempted to avoid overwriting it.`);
      }
      if (attempt === 2) throw error;
      expectedSha = current?.file.sha ?? expectedSha;
    }
  }
}

export async function initializeDatabase(): Promise<void> {
  console.error("GitHub Markdown storage initialized successfully.");
}

export async function testDatabaseConnection(): Promise<void> {
  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const result = await githubRequest<{
    full_name: string;
    private: boolean;
    default_branch: string;
  }>(url);

  console.error("GitHub repository connection successful:");
  console.error({
    full_name: result.full_name,
    private: result.private,
    default_branch: result.default_branch,
  });
}

export async function createThread(
  id: string,
  title?: string,
): Promise<Thread> {
  const now = new Date();

  const thread: Thread = {
    id,
    title: title ?? null,
    created_at: now,
    updated_at: now,
  };

  const content = renderMarkdown(thread, []);
  const titleForFile = safeMarkdownName(title ?? "Untitled Thread", "Untitled Thread");
  let filePath = `${conversationsPath}/${titleForFile}.md`;

  try {
    const existing = await listMarkdownFiles(conversationsPath);
    if (existing.some((file) => file.name.toLowerCase() === `${titleForFile}.md`.toLowerCase())) {
      filePath = `${conversationsPath}/${titleForFile} - ${id.slice(0, 8)}.md`;
    }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("GitHub API request failed (404)")) throw error;
  }

  await putFile(
    filePath,
    content,
    `Create thread ${id}`,
  );

  return thread;
}

export async function saveMessage(
  id: string,
  threadId: string,
  role: string,
  content: string,
): Promise<ThreadMessage> {
  const filePath = await findThreadFile(threadId);
  const { file, markdown } = await getFile(filePath);

  const stored = parseMarkdown(markdown, threadId);

  const message: ThreadMessage = {
    id,
    thread_id: threadId,
    role,
    content,
    created_at: new Date(),
  };

  stored.messages.push(message);
  stored.thread.updated_at = message.created_at;

  const updatedMarkdown = renderMarkdown(
    stored.thread,
    stored.messages,
  );

  await putFile(
    filePath,
    updatedMarkdown,
    `Save ${role} message ${id} to thread ${threadId}`,
    file.sha,
  );

  return message;
}

export async function getThread(
  threadId: string,
): Promise<{ thread: Thread; messages: ThreadMessage[] }> {
  const { markdown } = await getFile(await findThreadFile(threadId));

  return parseMarkdown(markdown, threadId);
}

export async function listThreads(): Promise<Thread[]> {
  const markdownFiles = [
    ...(await listMarkdownFiles(conversationsPath).catch((error) => {
      if (error instanceof Error && error.message.includes("GitHub API request failed (404)")) return [];
      throw error;
    })),
    ...(await listMarkdownFiles(threadsPath)),
  ];

  const threads: Thread[] = [];

  for (const file of markdownFiles) {
    try {
      const { markdown } = await getFile(file.path);
      const stored = parseMarkdown(markdown, file.name.replace(/\.md$/, ""));
      const { thread } = stored;
      if (threads.some((item) => item.id === thread.id)) continue;
      threads.push(thread);
    } catch (error) {
      console.error(
        `Unable to read thread file ${file.path}:`,
        error,
      );
    }
  }

  return threads.sort(
    (a, b) => b.updated_at.getTime() - a.updated_at.getTime(),
  );
}

export async function saveDocument(name: string, content: string): Promise<{ name: string; path: string }> {
  const safeName = safeMarkdownName(name.replace(/\.md$/i, ""), "Untitled Document");
  const filePath = `${documentsPath}/${safeName}.md`;
  let sha: string | undefined;

  try {
    const { file } = await getFile(filePath);
    sha = file.sha;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("GitHub API request failed (404)")) throw error;
  }

  await putFile(filePath, content, `Save document ${safeName}`, sha);
  return { name: `${safeName}.md`, path: filePath };
}

export async function getDocument(name: string): Promise<{ name: string; content: string }> {
  const safeName = safeMarkdownName(name.replace(/\.md$/i, ""), "Untitled Document");
  const filePath = `${documentsPath}/${safeName}.md`;
  const { markdown } = await getFile(filePath);
  return { name: `${safeName}.md`, content: markdown };
}

export async function listDocuments(): Promise<string[]> {
  try {
    const files = await listMarkdownFiles(documentsPath);
    return files.map((file) => file.name).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error instanceof Error && error.message.includes("GitHub API request failed (404)")) return [];
    throw error;
  }
}

export async function closeDatabase(): Promise<void> {
  console.error("GitHub Markdown storage does not require connection cleanup.");
}



