/**
 * Talk to the agent from the terminal: npm run chat
 * Uses the same agent, tools and knowledge base as the HTTP API.
 */
import readline from "node:readline";
import { getConfig } from "../src/agent/config";
import { runAgent } from "../src/agent/run-agent";
import { createToolDeps } from "../src/agent/tools";
import type { ChatTurn } from "../src/agent/types";

try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local: rely on the environment
}

const config = getConfig();
const deps = createToolDeps(config);
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const history: ChatTurn[] = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

console.log(
  dim(
    `model=${config.model} effort=${config.effort} calendar=${deps.calendar.mode} ` +
      `email=${config.resend && config.ownerEmail ? "resend" : "console"} tz=${timeZone}\n` +
      `Type a message, or "exit" to quit.\n`,
  ),
);

rl.setPrompt("you › ");
rl.prompt();
for await (const line of rl) {
  const input = line.trim();
  if (input === "exit") break;
  if (!input) {
    rl.prompt();
    continue;
  }
  history.push({ role: "user", content: input });

  let reply = "";
  let afterTool = false;
  const sources: string[] = [];
  process.stdout.write("\nagent › ");
  try {
    const result = await runAgent({
      history,
      visitor: { timeZone },
      deps,
      onEvent: (e) => {
        if (e.type === "text") {
          if (afterTool && reply) process.stdout.write("\n");
          afterTool = false;
          reply += e.text;
          process.stdout.write(e.text);
        } else if (e.type === "citation") {
          sources.push(`${e.title}: "${e.quote}"`);
          process.stdout.write(dim(`[${sources.length}]`));
        } else if (e.type === "tool_call") {
          afterTool = true;
          process.stdout.write(dim(`\n  → ${e.name}…\n`));
        } else if (e.type === "tool_result") {
          process.stdout.write(dim(`  ← ${e.name} ${e.ok ? "ok" : "failed"} ${JSON.stringify(e.data ?? {}).slice(0, 200)}\n`));
        } else if (e.type === "error") {
          process.stdout.write(`\n[error] ${e.message}`);
        }
      },
    });
    const u = result.usage;
    sources.forEach((s, i) => console.log(dim(`\n  [${i + 1}] ${s}`)));
    console.log(dim(`\n  (tokens in=${u.input} cached=${u.cacheRead} out=${u.output})\n`));
  } catch (err) {
    console.error("\n[failed]", err instanceof Error ? err.message : err);
  }
  // Keep the history valid (alternating turns) even when a turn produced no text.
  if (reply) history.push({ role: "assistant", content: reply });
  else history.pop();
  rl.prompt();
}
rl.close();
