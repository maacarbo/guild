/**
 * `guild demo` — post the known-good demo idea as a board ticket (D11: the
 * idea is a ticket; there is no other entry point) and print what to do on
 * the board. The conductor answers with the plan gate; every advance after
 * that is an operator lane move.
 */

import { readEnv } from "./env.js";

const env = readEnv([
  { name: "GUILD_MULTICA_URL", source: "Multica backend URL", fallback: "http://127.0.0.1:8080" },
  { name: "GUILD_OPERATOR_TOKEN", source: "the OPERATOR's PAT (ideas must be operator-authored)" },
  { name: "GUILD_WORKSPACE_ID", source: "the project workspace" },
  { name: "GUILD_DEMO_BUDGET", source: "plan budget in dollars", fallback: "1.00" },
]);

async function main(): Promise<void> {
  const res = await fetch(`${env.GUILD_MULTICA_URL}/api/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GUILD_OPERATOR_TOKEN}`,
      "x-workspace-id": env.GUILD_WORKSPACE_ID,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "Demo: word-count CLI",
      description: [
        "Build a tiny word-count command-line tool in this repository.",
        "",
        "Requirements: a Node.js >= 22 executable script bin/wc.mjs that prints the",
        "number of whitespace-separated words in a UTF-8 text file passed as its",
        "only argument; zero runtime dependencies; tests runnable offline with",
        "`node --test`.",
        "",
        `budget: ${env.GUILD_DEMO_BUDGET}`,
      ].join("\n"),
    }),
  });
  if (!res.ok) {
    console.error(`idea ticket → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const issue = (await res.json()) as { id: string; identifier: string };
  console.log(`Demo idea posted: ${issue.identifier} (${issue.id})`);
  console.log("");
  console.log("On the board, the conductor will answer with a plan-approval ticket per stage:");
  console.log("  approve  → move the plan ticket to  Ready to work");
  console.log("  amend    → comment  amend: <note>   on the plan ticket");
  console.log("  reject   → move the plan ticket to  Cancelled");
  console.log("  accept   → move a validated stage ticket to  Done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
