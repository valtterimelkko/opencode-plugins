/**
 * Goal Engine — TUI command palette registration
 *
 * Separate from the server plugin (index.js) because OpenCode enforces a strict
 * server/tui split: a module with a server default export cannot also have a tui
 * named export (the server loader crashes trying to call it as a hook).
 *
 * This module exports only `tui` and registers /goal + subcommands in the
 * OpenCode command palette for slash-key autocomplete.
 */

export const tui = async (api) => {
  if (!api?.command?.register) return;

  api.command.register(() => [
    {
      title: "goal <objective>",
      value: "/goal ",
      description: "Start autonomous goal — agent works until objective is achieved",
      category: "Goal Engine",
      slash: { name: "goal" },
    },
    {
      title: "goal status",
      value: "/goal status",
      description: "Show current goal status and progress",
      category: "Goal Engine",
    },
    {
      title: "goal report",
      value: "/goal report",
      description: "Detailed goal execution report",
      category: "Goal Engine",
    },
    {
      title: "goal pause",
      value: "/goal pause",
      description: "Pause the goal gracefully after the current step",
      category: "Goal Engine",
    },
    {
      title: "goal pause-now",
      value: "/goal pause-now",
      description: "Pause the goal immediately",
      category: "Goal Engine",
    },
    {
      title: "goal resume",
      value: "/goal resume",
      description: "Resume a paused goal",
      category: "Goal Engine",
    },
    {
      title: "goal clear",
      value: "/goal clear",
      description: "Abandon and clear the current goal",
      category: "Goal Engine",
    },
  ]);
};
