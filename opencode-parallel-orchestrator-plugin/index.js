import { tool } from "@opencode-ai/plugin/tool";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execAsync = promisify(execCallback);

const activeOrchestrations = new Map();
const worktreeRegistry = new Map();

async function git(cwd, ...args) {
  const { stdout } = await execAsync(`git ${args.join(" ")}`, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function getRepoRoot(cwd) {
  return await git(cwd, "rev-parse", "--show-toplevel");
}

async function getCurrentBranch(cwd) {
  try {
    return await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  } catch {
    return "main";
  }
}

function generateWorktreeId() {
  return `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function parsePlanFile(content) {
  const tasks = [];
  const lines = content.split("\n");
  let currentTask = null;
  let taskIndex = 0;

  for (const line of lines) {
    const taskMatch = line.match(/^#{2,4}\s*(?:Task\s*)?(\d+\.?\s*)?(.+)$/i);
    if (taskMatch) {
      if (currentTask && currentTask.title) {
        tasks.push(currentTask);
      }
      currentTask = {
        id: `task-${taskIndex + 1}`,
        title: taskMatch[2].trim(),
        description: "",
      };
      taskIndex++;
    } else if (currentTask) {
      currentTask.description =
        (currentTask.description || "") + line + "\n";
    }
  }
  if (currentTask && currentTask.title) {
    tasks.push(currentTask);
  }

  return tasks;
}

export default async function ParallelOrchestratorPlugin(input) {
  return {
    tool: {
      worktree: tool({
        description:
          "Manage git worktrees for isolated development. " +
          "Use 'create' to create a new worktree with its own branch. " +
          "Use 'list' to list all worktrees. " +
          "Use 'delete' to remove a worktree and its branch. " +
          "Use 'status' to check a worktree's current state.",
        args: {
          action: tool.schema.enum(["create", "list", "delete", "status"]),
          taskId: tool.schema
            .string()
            .optional()
            .describe("Unique identifier for the task (create)"),
          taskDescription: tool.schema
            .string()
            .optional()
            .describe("Description of the task (create)"),
          baseBranch: tool.schema
            .string()
            .optional()
            .describe("Base branch to create from (default: current branch)"),
          worktreeId: tool.schema
            .string()
            .optional()
            .describe("Worktree ID for delete/status operations"),
        },
        async execute(args, ctx) {
          const cwd = ctx.directory || process.cwd();
          const repoRoot = await getRepoRoot(cwd);

          switch (args.action) {
            case "create": {
              if (!args.taskId || !args.taskDescription) {
                return {
                  output:
                    "Error: taskId and taskDescription are required for create action",
                  metadata: { error: true },
                };
              }

              const baseBranch =
                args.baseBranch || (await getCurrentBranch(repoRoot));
              const worktreeId = generateWorktreeId();
              const branchName = `task-${args.taskId}-${args.taskDescription
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "-")
                .slice(0, 30)}`;
              const worktreePath = path.join(
                path.dirname(repoRoot),
                path.basename(repoRoot) + "-" + worktreeId,
              );

              try {
                await git(
                  repoRoot,
                  "worktree",
                  "add",
                  "-b",
                  branchName,
                  worktreePath,
                  baseBranch,
                );

                worktreeRegistry.set(worktreeId, {
                  id: worktreeId,
                  path: worktreePath,
                  branch: branchName,
                  task: args.taskDescription,
                  status: "idle",
                  createdAt: new Date().toISOString(),
                });

                ctx.metadata({
                  title: `worktree create: ${args.taskId}`,
                  metadata: { worktreeId, branchName, worktreePath },
                });

                return {
                  output: `Created worktree:\n  ID: ${worktreeId}\n  Path: ${worktreePath}\n  Branch: ${branchName}\n  Base: ${baseBranch}`,
                  metadata: { worktreeId, branchName, worktreePath },
                };
              } catch (error) {
                return {
                  output: `Failed to create worktree: ${error instanceof Error ? error.message : "Unknown error"}`,
                  metadata: { error: true },
                };
              }
            }

            case "list": {
              try {
                const output = await git(
                  repoRoot,
                  "worktree",
                  "list",
                  "--porcelain",
                );
                const lines = output.split("\n");
                const worktrees = [];
                let current = {};

                for (const line of lines) {
                  if (line.startsWith("worktree ")) {
                    if (current.path) worktrees.push(current);
                    current = { path: line.slice(9) };
                  } else if (line.startsWith("HEAD ")) {
                    current.commit = line.slice(5).slice(0, 7);
                  } else if (line.startsWith("branch ")) {
                    current.branch = line.slice(7);
                  }
                }
                if (current.path) worktrees.push(current);

                if (worktrees.length === 0) {
                  return { output: "No worktrees found." };
                }

                const listItems = worktrees
                  .map((wt, i) => {
                    const registered = Array.from(
                      worktreeRegistry.values(),
                    ).find((w) => w.path === wt.path);
                    const status = registered?.status || "unknown";
                    const task = registered?.task || "(main repo)";
                    return `${i + 1}. ${wt.path}\n   Branch: ${wt.branch || "detached"}\n   Task: ${task}\n   Status: ${status}`;
                  })
                  .join("\n\n");

                return {
                  output: `Worktrees:\n\n${listItems}`,
                  metadata: {
                    worktrees,
                    registered: Array.from(worktreeRegistry.values()),
                  },
                };
              } catch (error) {
                return {
                  output: `Failed to list worktrees: ${error instanceof Error ? error.message : "Unknown error"}`,
                  metadata: { error: true },
                };
              }
            }

            case "delete": {
              if (!args.worktreeId) {
                return {
                  output:
                    "Error: worktreeId is required for delete action",
                  metadata: { error: true },
                };
              }

              const worktree = worktreeRegistry.get(args.worktreeId);
              if (!worktree) {
                return {
                  output: `Worktree ${args.worktreeId} not found in registry`,
                };
              }

              try {
                await git(
                  repoRoot,
                  "worktree",
                  "remove",
                  worktree.path,
                  "--force",
                );
                await git(repoRoot, "branch", "-D", worktree.branch);
                worktreeRegistry.delete(args.worktreeId);

                ctx.metadata({
                  title: `worktree delete: ${args.worktreeId}`,
                });

                return {
                  output: `Deleted worktree ${args.worktreeId}`,
                };
              } catch (error) {
                return {
                  output: `Failed to delete worktree: ${error instanceof Error ? error.message : "Unknown error"}`,
                  metadata: { error: true },
                };
              }
            }

            case "status": {
              if (!args.worktreeId) {
                return {
                  output:
                    "Error: worktreeId is required for status action",
                  metadata: { error: true },
                };
              }

              const worktree = worktreeRegistry.get(args.worktreeId);
              if (!worktree) {
                return {
                  output: `Worktree ${args.worktreeId} not found`,
                };
              }

              try {
                const status = await git(
                  worktree.path,
                  "status",
                  "--short",
                );
                const logCount = await git(
                  worktree.path,
                  "rev-list",
                  "--count",
                  "HEAD",
                );

                ctx.metadata({
                  title: `worktree status: ${args.worktreeId}`,
                  metadata: { worktree, logCount },
                });

                return {
                  output: `Worktree ${args.worktreeId}:\n  Path: ${worktree.path}\n  Branch: ${worktree.branch}\n  Task: ${worktree.task}\n  Status: ${worktree.status}\n  Uncommitted: ${status.length > 0 ? "Yes" : "No"}\n  Commits: ${logCount}${status ? `\n\n  Changes:\n${status}` : ""}`,
                  metadata: { worktree, logCount },
                };
              } catch (error) {
                return {
                  output: `Failed to get status: ${error instanceof Error ? error.message : "Unknown error"}`,
                  metadata: { error: true },
                };
              }
            }

            default:
              return { output: `Unknown action: ${args.action}` };
          }
        },
      }),

      orchestrate: tool({
        description:
          "Start a parallel orchestration from a modular plan file. " +
          "Parses markdown files with ## Task headers and creates worktrees for parallelizable tasks.",
        args: {
          planFile: tool.schema
            .string()
            .describe("Path to the plan file (markdown with ## Task headers)"),
          mode: tool.schema
            .enum(["auto", "manual"])
            .optional()
            .describe("Orchestration mode (default: auto)"),
          maxParallel: tool.schema
            .number()
            .optional()
            .describe("Maximum parallel tasks (default: 4)"),
          baseBranch: tool.schema
            .string()
            .optional()
            .describe("Base branch for worktrees"),
        },
        async execute(args, ctx) {
          const cwd = ctx.directory || process.cwd();
          const planPath = path.resolve(cwd, args.planFile);

          try {
            const planContent = await fs.readFile(planPath, "utf-8");
            const orchestrationId = `orch-${Date.now().toString(36)}`;

            const tasks = parsePlanFile(planContent);

            if (tasks.length === 0) {
              return {
                output:
                  "No tasks found in plan. Use ## Task headers to define tasks.",
                metadata: { error: true },
              };
            }

            activeOrchestrations.set(orchestrationId, {
              id: orchestrationId,
              planPath,
              worktrees: [],
              status: "initializing",
              currentGroup: 0,
            });

            const taskList = tasks
              .map(
                (t, i) =>
                  `${i + 1}. **${t.title}**\n   ID: ${t.id}\n   ${t.description.slice(0, 100)}${t.description.length > 100 ? "..." : ""}`,
              )
              .join("\n\n");

            ctx.metadata({
              title: `orchestrate: ${tasks.length} tasks`,
              metadata: { orchestrationId, tasks },
            });

            return {
              output: `Orchestration Ready!\n\nID: ${orchestrationId}\nPlan: ${planPath}\nTasks: ${tasks.length}\n\n${taskList}\n\nUse the worktree tool to create worktrees for each task.`,
              metadata: { orchestrationId, tasks, planPath },
            };
          } catch (error) {
            return {
              output: `Failed to start orchestration: ${error instanceof Error ? error.message : "Unknown error"}`,
              metadata: { error: true },
            };
          }
        },
      }),

      merge_worktree: tool({
        description:
          "Merge a worktree branch back into the base branch. " +
          "Supports merge, squash, and rebase strategies with conflict detection.",
        args: {
          worktreeId: tool.schema
            .string()
            .describe("ID of the worktree to merge"),
          strategy: tool.schema
            .enum(["merge", "squash", "rebase"])
            .describe("Merge strategy"),
          message: tool.schema
            .string()
            .optional()
            .describe("Commit message for the merge"),
        },
        async execute(args, ctx) {
          const cwd = ctx.directory || process.cwd();
          const repoRoot = await getRepoRoot(cwd);

          const worktree = worktreeRegistry.get(args.worktreeId);
          if (!worktree) {
            return {
              output: `Worktree ${args.worktreeId} not found`,
            };
          }

          try {
            const status = await git(worktree.path, "status", "--short");
            if (status.length > 0) {
              await git(worktree.path, "add", "-A");
              await git(
                worktree.path,
                "commit",
                "-m",
                `WIP: ${worktree.task}`,
              );
            }

            const baseBranch =
              worktree.branch
                .split("-")
                .slice(0, -1)
                .join("-") || "main";
            await git(repoRoot, "checkout", baseBranch);

            const strategy = args.strategy || "merge";
            const message =
              args.message || `Merge ${worktree.branch}: ${worktree.task}`;

            if (strategy === "squash") {
              await git(repoRoot, "merge", "--squash", worktree.branch);
              await git(repoRoot, "commit", "-m", message);
            } else if (strategy === "rebase") {
              await git(worktree.path, "rebase", baseBranch);
              await git(repoRoot, "merge", "--ff-only", worktree.branch);
            } else {
              await git(
                repoRoot,
                "merge",
                worktree.branch,
                "-m",
                message,
              );
            }

            worktree.status = "merged";

            ctx.metadata({
              title: `merge: ${args.worktreeId} (${strategy})`,
              metadata: { worktreeId: args.worktreeId, strategy },
            });

            return {
              output: `Merged worktree ${args.worktreeId}\n  Branch: ${worktree.branch}\n  Strategy: ${strategy}\n  Into: ${baseBranch}`,
            };
          } catch (error) {
            try {
              const conflictStatus = await git(
                repoRoot,
                "status",
                "--short",
              );
              if (conflictStatus.includes("UU")) {
                return {
                  output: `Merge has conflicts!\n\nConflicted files:\n${conflictStatus.split("\n").filter((l) => l.includes("UU")).join("\n")}\n\nResolve conflicts manually, then run: git commit`,
                  metadata: { conflicts: true },
                };
              }
            } catch {
              // ignore secondary error
            }

            return {
              output: `Failed to merge: ${error instanceof Error ? error.message : "Unknown error"}`,
              metadata: { error: true },
            };
          }
        },
      }),
    },
  };
}
