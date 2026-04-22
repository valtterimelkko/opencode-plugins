import { tool } from "@opencode-ai/plugin/tool";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const OPENCODE_DIR = path.join(os.homedir(), ".opencode");

const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;
const MAX_SESSION_MEMORY_LINES = 300;
const MAX_SESSION_MEMORY_BYTES = 40_000;

function getMemoryDir(slug) {
  return path.join(OPENCODE_DIR, "memory", slug);
}

function getEntrypointPath(slug) {
  return path.join(getMemoryDir(slug), "MEMORY.md");
}

function getSessionMemoryDir() {
  return path.join(OPENCODE_DIR, "session-memory");
}

function getSessionMemoryPath(sessionID) {
  return path.join(getSessionMemoryDir(), `${sessionID}.md`);
}

function projectSlug(cwd) {
  return path
    .basename(cwd)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .toLowerCase();
}

function formatDate() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readFileContent(filePath) {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function writeFileContent(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf-8");
}

async function listFiles(dirPath, extension = ".md") {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(extension))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function truncateContent(content, maxLines, maxBytes) {
  const originalLines = content.split("\n").length;
  const originalBytes = Buffer.byteLength(content, "utf-8");
  let result = content;

  const lines = result.split("\n");
  if (lines.length > maxLines) {
    result =
      lines.slice(0, maxLines).join("\n") +
      `\n\n<!-- Memory truncated at ${maxLines} lines (was ${originalLines}) -->`;
  }

  const bytes = Buffer.byteLength(result, "utf-8");
  if (bytes > maxBytes) {
    const buf = Buffer.from(result, "utf-8");
    let cutPoint = maxBytes;
    while (cutPoint > 0 && buf[cutPoint] !== 0x0a) {
      cutPoint--;
    }
    if (cutPoint === 0) cutPoint = maxBytes;
    result =
      buf.slice(0, cutPoint).toString("utf-8") +
      `\n\n<!-- Memory truncated at ~${maxBytes} bytes -->`;
  }

  return result;
}

function buildMemoryBlock(sessionMemory, autoMemory) {
  const parts = [];

  if (autoMemory.trim()) {
    parts.push("## Project Knowledge (persistent, from MEMORY.md)");
    parts.push(autoMemory.trim());
    parts.push("");
  }

  if (sessionMemory.trim()) {
    parts.push("## Session Context (auto-extracted this session)");
    parts.push(sessionMemory.trim());
  }

  if (parts.length === 0) return "";

  return `<opencode-memory>\n${parts.join("\n")}\n</opencode-memory>`;
}

function extractFromToolCalls(toolCalls) {
  const filesRead = [];
  const filesWritten = [];
  const commandsRun = [];
  const decisions = [];

  const decisionPatterns = [
    /(?:I|we|let's|should)\s+(?:will|should)?\s*(?:use|go with|implement|choose|decided to|refactor to|switch to)\s+(.+)/gi,
  ];

  for (const tc of toolCalls) {
    if (tc.name === "read" && tc.args?.path) {
      filesRead.push(String(tc.args.path));
    } else if (tc.name === "write" && tc.args?.path) {
      filesWritten.push(String(tc.args.path));
    } else if (
      tc.name === "edit" &&
      (tc.args?.filePath || tc.args?.path)
    ) {
      filesWritten.push(String(tc.args.filePath || tc.args.path));
    } else if (tc.name === "bash" && tc.args?.command) {
      const cmd = String(tc.args.command);
      if (cmd.length < 200) {
        commandsRun.push(cmd);
      }
    }

    const textToScan = typeof tc.output === "string" ? tc.output : "";
    for (const pattern of decisionPatterns) {
      let match;
      while ((match = pattern.exec(textToScan)) !== null) {
        const decision = match[1]?.trim();
        if (decision && decision.length > 5 && decision.length < 200) {
          decisions.push(decision.slice(0, 150));
        }
      }
    }
  }

  const topics = [];
  for (const f of [...filesRead, ...filesWritten]) {
    const parts = f.split("/");
    if (parts.length > 1) {
      topics.push(parts[parts.length - 2]);
    }
    const ext = f.split(".").pop();
    if (ext && ext.length < 6) {
      topics.push(ext);
    }
  }

  const summaryParts = [];
  if (filesRead.length > 0) {
    summaryParts.push(`Read: ${filesRead.slice(0, 5).join(", ")}`);
  }
  if (filesWritten.length > 0) {
    summaryParts.push(`Modified: ${filesWritten.slice(0, 5).join(", ")}`);
  }
  if (commandsRun.length > 0 && commandsRun.length <= 3) {
    summaryParts.push(
      `Ran: ${commandsRun.map((c) => (c.length > 50 ? c.slice(0, 50) + "\u2026" : c)).join("; ")}`,
    );
  }
  const summary = summaryParts.join(". ") || "No significant tool activity";

  return {
    summary,
    decisions,
    topics: [...new Set(topics)].slice(0, 10),
  };
}

function formatSessionMemoryUpdate(turnIndex, extraction) {
  const lines = [];
  lines.push(`### Turn ${turnIndex + 1}`);
  lines.push(`**Summary**: ${extraction.summary}`);

  if (extraction.decisions.length > 0) {
    lines.push("**Decisions**:");
    for (const d of extraction.decisions) {
      lines.push(`- ${d}`);
    }
  }

  return lines.join("\n") + "\n\n";
}

async function appendAutoMemoryTopics(slug, entries) {
  if (entries.length === 0) return;

  const memoryDir = getMemoryDir(slug);
  await ensureDir(memoryDir);

  let existing = (await readFileContent(getEntrypointPath(slug))) || "";

  const additions = [];
  for (const entry of entries) {
    const topic = entry.topics[0] || "general";
    if (!existing.includes(entry.content)) {
      additions.push(`- [${topic}] ${entry.content}`);
    }
  }

  if (additions.length === 0) return;

  if (!existing.trim()) {
    existing =
      "# Project Memory\n\nAuto-generated by OpenCode Memory Plugin.\nKey facts, decisions, and patterns discovered while working on this project.\n\n";
  }

  const today = formatDate();
  if (!existing.includes(`## ${today}`)) {
    existing += `\n## ${today}\n\n`;
  }

  existing += additions.join("\n") + "\n";

  const truncated = truncateContent(
    existing,
    MAX_ENTRYPOINT_LINES,
    MAX_ENTRYPOINT_BYTES,
  );
  await writeFileContent(getEntrypointPath(slug), truncated);
}

const sessions = new Map();
let globalSlug = "";

function getSession(sessionID) {
  if (!sessions.has(sessionID)) {
    sessions.set(sessionID, {
      sessionMemory: "",
      autoMemory: "",
      turnCount: 0,
      turnToolCalls: [],
    });
  }
  return sessions.get(sessionID);
}

async function loadSessionMemoryFromDisk(sessionID) {
  const filePath = getSessionMemoryPath(sessionID);
  return (await readFileContent(filePath)) || "";
}

async function saveSessionMemoryToDisk(sessionID, content) {
  const truncated = truncateContent(
    content,
    MAX_SESSION_MEMORY_LINES,
    MAX_SESSION_MEMORY_BYTES,
  );
  await writeFileContent(getSessionMemoryPath(sessionID), truncated);
}

export default async function MemoryPlugin(input) {
  globalSlug = projectSlug(input.directory);
  const initialAutoMemory =
    (await readFileContent(getEntrypointPath(globalSlug))) || "";

  return {
    tool: {
      memory: tool({
        description:
          "Manage persistent memory for this project. " +
          "Use 'save' to store important facts, decisions, or patterns. " +
          "Use 'search' to find relevant past memories. " +
          "Use 'show' to display current memories. " +
          "Use 'list' to list all memory topics. " +
          "Use 'edit' to directly edit the memory file. " +
          "Use 'clear' to delete all memories (destructive).",
        args: {
          action: tool.schema.enum([
            "save",
            "search",
            "show",
            "list",
            "edit",
            "clear",
          ]),
          content: tool.schema
            .string()
            .optional()
            .describe("Content to save (for save/edit)"),
          topic: tool.schema
            .string()
            .optional()
            .describe("Topic/category (for save/edit)"),
          query: tool.schema
            .string()
            .optional()
            .describe("Search query (for search)"),
        },
        async execute(args, ctx) {
          const session = getSession(ctx.sessionID);
          if (!session.autoMemory) {
            session.autoMemory =
              (await readFileContent(getEntrypointPath(globalSlug))) || "";
          }

          switch (args.action) {
            case "save": {
              if (!args.content)
                return "Error: content is required for save action";
              const topic = args.topic || "general";
              await appendAutoMemoryTopics(globalSlug, [
                {
                  type: "learned",
                  date: formatDate(),
                  topics: [topic],
                  content: args.content,
                },
              ]);
              session.autoMemory =
                (await readFileContent(getEntrypointPath(globalSlug))) || "";
              session.sessionMemory += `**Saved**: [${topic}] ${args.content}\n`;
              await saveSessionMemoryToDisk(
                ctx.sessionID,
                session.sessionMemory,
              );
              return `Saved to memory under "${topic}": ${args.content.slice(0, 100)}${args.content.length > 100 ? "..." : ""}`;
            }

            case "search": {
              if (!args.query)
                return "Error: query is required for search action";
              const allMemory =
                session.autoMemory + "\n" + session.sessionMemory;
              if (!allMemory.trim()) return "No memories stored yet.";
              const query = args.query.toLowerCase();
              const matches = allMemory
                .split("\n")
                .filter((line) => line.toLowerCase().includes(query));
              if (matches.length === 0)
                return `No memories matching "${args.query}".`;
              return `Found ${matches.length} matching memories for "${args.query}":\n\n${matches.slice(0, 20).join("\n")}`;
            }

            case "show": {
              const parts = [];
              if (session.autoMemory.trim()) {
                parts.push("=== Project Memory (MEMORY.md) ===\n");
                parts.push(session.autoMemory);
              }
              if (session.sessionMemory.trim()) {
                parts.push("\n=== Session Memory ===\n");
                parts.push(session.sessionMemory);
              }
              if (parts.length === 0) parts.push("No memories stored yet.");
              return parts.join("\n");
            }

            case "list": {
              const memoryDir = getMemoryDir(globalSlug);
              const files = await listFiles(memoryDir);
              if (files.length === 0)
                return "No memory files. Use 'save' to create one.";
              const listing = files
                .slice(0, 20)
                .map((f) => `- ${f}`)
                .join("\n");
              return `Memory files:\n${listing}`;
            }

            case "edit": {
              if (!args.content)
                return "Error: content is required for edit action";
              await writeFileContent(
                getEntrypointPath(globalSlug),
                args.content,
              );
              session.autoMemory = args.content;
              return "Memory updated.";
            }

            case "clear": {
              await writeFileContent(getEntrypointPath(globalSlug), "");
              session.autoMemory = "";
              await writeFileContent(
                getSessionMemoryPath(ctx.sessionID),
                "",
              );
              session.sessionMemory = "";
              return "All memories cleared.";
            }

            default:
              return `Unknown action: ${args.action}`;
          }
        },
      }),
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID || "default";
      const session = getSession(sessionID);
      if (!session.autoMemory) {
        session.autoMemory =
          (await readFileContent(getEntrypointPath(globalSlug))) || "";
      }
      if (!session.sessionMemory) {
        session.sessionMemory = await loadSessionMemoryFromDisk(sessionID);
      }
      const block = buildMemoryBlock(
        session.sessionMemory,
        session.autoMemory,
      );
      if (block) {
        output.system.push(block);
      }
    },

    "tool.execute.after": async (input, output) => {
      const session = getSession(input.sessionID);

      const tc = {
        name: input.tool,
        args: input.args,
        output: output.output,
      };
      session.turnToolCalls.push(tc);

      const significantTools = [
        "read",
        "write",
        "edit",
        "bash",
        "opencode-memory-plugin/memory",
      ];
      if (significantTools.includes(input.tool)) {
        const extraction = extractFromToolCalls(session.turnToolCalls);

        if (extraction.summary && extraction.summary !== "No significant tool activity") {
          const update = formatSessionMemoryUpdate(
            session.turnCount,
            extraction,
          );
          session.sessionMemory += update;
          session.turnCount++;

          await saveSessionMemoryToDisk(
            input.sessionID,
            session.sessionMemory,
          );
        }

        if (extraction.decisions.length > 0) {
          const entries = extraction.decisions.map((d) => ({
            type: "decision",
            date: formatDate(),
            topics: extraction.topics,
            content: d,
          }));
          await appendAutoMemoryTopics(globalSlug, entries);
          session.autoMemory =
            (await readFileContent(getEntrypointPath(globalSlug))) || "";
        }

        session.turnToolCalls = [];
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const session = getSession(input.sessionID);
      if (session.sessionMemory) {
        await saveSessionMemoryToDisk(
          input.sessionID,
          session.sessionMemory,
        );
        output.context.push(session.sessionMemory);
      }
      if (session.autoMemory) {
        output.context.push(
          "Project memory from MEMORY.md:\n" + session.autoMemory,
        );
      }
    },
  };
}
