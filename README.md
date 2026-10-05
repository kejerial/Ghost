# Ghost

Ghost is a Slack teammate. Ask it a question with `@ghost <question>` in a channel or thread. Ghost replies in the thread. It uses Slack history and general model knowledge, and it links every Slack fact to its source message.

Ghost is a personal assistant. It runs on your Mac. It calls the `claude` or `codex` CLI that you are already logged in to. It does not use metered API billing.

## How it works

```
@ghost mention
→ add a 👀 reaction to the question
→ read the current thread and recent channel messages (Slack API)
→ search older messages in the local index (SQLite FTS5)
→ pack the context into a fixed character budget, with an [S#] ID per message
→ call the model CLI (no tools, empty working directory, prompt on stdin)
→ turn [S#] citations into Slack links, add a Sources list, post the answer in the thread
→ remove the 👀 reaction
```

Ghost keeps a local index in `data/ghost.db`. It fills the index from channels that it is a member of: a backfill at startup, live message events, and a resync every 6 hours.

## Safety rules

- Ghost reads only channels that it is a member of. It uses all of them when it answers.
- When Ghost leaves a channel, or the channel is archived, Ghost deletes that channel's messages from the index.
- The model subprocess has no tools and no MCP servers. It cannot read files or run commands. Its environment contains no Slack tokens.
- Ghost turns off link unfurls and Slack parsing on its replies, so model output cannot ping people or channels.

## Set up

The Slack CLI creates the app from `manifest.json`, installs it, and gives Ghost its tokens. You do not copy any tokens.

1. Install the Slack CLI.
```bash
curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash
```
2. Log in. The CLI prints a slash command. Paste it into any Slack channel, select **Confirm**, then paste the code back into the terminal.
```bash
slack login
```
3. Make sure the model CLI works. `.env` sets `GHOST_BACKEND` (`claude` or `codex`).
```bash
codex exec "Reply with PONG"
```
4. Start Ghost. The first run asks which workspace to install to.
```bash
slack run
```
5. In your personal channel, and in each channel Ghost should read, type `/invite @ghost`.

Ghost answers only while `slack run` runs. `slack run` installs a development copy of the app in your workspace.

## Chat in your personal channel

In any channel where you are the only human member, Ghost answers every message you send, with no tag. It replies in the channel, or in the thread when you write in a thread. In other channels, tag `@Ghost`; Ghost replies in the thread. To force chat mode in one specific channel, set `GHOST_HOME_CHANNEL` in `.env`.

## Run in the background

`slack run` stops when you close its terminal. To keep Ghost running, use the "Ghost" app (not "Ghost (local)") and a macOS login item.

1. Open the app settings page: <https://api.slack.com/apps/A0XXXXXXXXX>.
2. Open **OAuth & Permissions**. Copy the **Bot User OAuth Token** into `.env` as `SLACK_BOT_TOKEN`.
3. Open **Basic Information → App-Level Tokens**. Generate a token with the `connections:write` scope. Copy it into `.env` as `SLACK_APP_TOKEN`.
4. Stop any running `slack run`. Then install the login item:
```bash
scripts/service.sh install
```

Ghost then starts at login and restarts after a crash. It runs only while your Mac is awake. Use `scripts/service.sh restart` after a change, and `scripts/service.sh logs` to read the log.

## Commands

| Command | Purpose |
| --- | --- |
| `slack run` | Run Ghost with tokens from the Slack CLI. |
| `npm start` | Run Ghost with tokens from `.env`. |
| `scripts/service.sh install` | Run Ghost in the background at every login. |
| `npm run doctor` | Check the tokens, scopes, database, and backend. Add `-- --live` to send one test prompt. |
| `npm run ask -- --channel C0123 "question"` | Run the full pipeline on real Slack data and print the answer. Posts nothing. Add `--thread TS` or `--sync`. |
| `npm test` | Run the unit and pipeline tests. |
| `npm run test:smoke` | Call the real model CLI with fake Slack data. Set `GHOST_SMOKE_BACKEND=codex` to test Codex. |

## Configuration

`.env.example` lists every variable with its default.

## Model backends

All backends implement `ModelBackend` in `src/backend/types.ts`.

| Backend | How it runs |
| --- | --- |
| `claude` | `claude -p --tools "" --strict-mcp-config --setting-sources ""`, prompt on stdin. |
| `codex` | `codex exec --ignore-user-config -s read-only`, every tool feature disabled, prompt on stdin. |
| `openai-compatible` | `POST {GHOST_PROXY_URL}/chat/completions`. Use it with a local subscription proxy. |

## Roadmap

- Durable memories: extract decisions, project facts, customer context, preferences, and open questions into a `memories` table.
- Postgres + pgvector: semantic search with a hybrid score. Replace `FtsRetriever` behind the `Retriever` interface.
- A model query-rewrite step before retrieval.
