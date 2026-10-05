/**
 * `npm run ask -- --channel C0123 [--thread 1712345678.000100] [--sync] "question"`
 *
 * Runs the full answer pipeline against real Slack data and prints the reply.
 * It reads Slack but posts nothing. Use it to test prompts and retrieval.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { setLogLevel } from "./log.js";
import { createRuntime } from "./runtime.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: "string" },
    thread: { type: "string" },
    sync: { type: "boolean", default: false },
  },
});

const question = positionals.join(" ").trim();
if (!values.channel || !question) {
  console.error('Usage: npm run ask -- --channel C0123 [--thread TS] [--sync] "your question"');
  process.exit(2);
}

const config = loadConfig();
setLogLevel(config.logLevel === "info" ? "warn" : config.logLevel);
const runtime = await createRuntime(config);
if (values.sync) await runtime.syncer.syncAll();

const nowTs = (Date.now() / 1000).toFixed(6);
const answer = await runtime.ghost.answer(
  { channel: values.channel, ts: nowTs, thread_ts: values.thread, user: undefined, text: question },
  question,
);
console.log(answer.text);
console.error(`\n[${answer.sourceCount} sources in context, ${answer.citedCount} cited]`);
runtime.store.db.close();
