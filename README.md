# Ghost

A personal Slack assistant that runs on your Mac. It answers with your Slack history, the web, and the ChatGPT (Codex CLI) or Claude (Claude Code CLI) subscription you already have. No API billing, no server.

- In a channel where you are the only human member, Ghost answers every message. No tag needed.
- In other channels, tag `@Ghost`. Ghost replies in the thread.
- Ghost cites the Slack messages it uses and links web sources when they help.

## Setup

Fastest path: open this repo in Claude Code or Codex and say **"Set up Ghost by following the README."** The agent runs every step. Steps marked **Human step** need you in Slack or a browser.

1. Check the prerequisites. Node 22 or later is required. At least one model CLI must be logged in.
   ```bash
   node --version
   ```
   ```bash
   codex login status
   ```
   If you use Claude instead, `claude -p "Reply with PONG"` must print PONG.
2. Install and test.
   ```bash
   npm install && npm test
   ```
3. Install the Slack CLI.
   ```bash
   curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash
   ```
4. **Human step.** Run `slack login`. Paste the printed `/slackauthticket ...` command into any Slack channel, select **Confirm**, and paste the code back into the terminal.
5. **Human step.** Create and install the app from `manifest.json`. Pick your workspace when asked.
   ```bash
   slack app install -E deployed
   ```
6. Create `.env`. Set `GHOST_BACKEND=codex` or `GHOST_BACKEND=claude`.
   ```bash
   cp .env.example .env
   ```
7. **Human step.** Run `slack app settings` to open the app page. Copy two tokens:
   - **OAuth & Permissions → Bot User OAuth Token** (`xoxb-...`)
   - **Basic Information → App-Level Tokens → Generate**, with scope `connections:write` (`xapp-...`)

   Then run this command (zsh, the macOS default) and paste each token at its prompt. The tokens are not echoed and do not go into shell history.
   ```bash
   read -rs "BOT?Bot token: " && echo && read -rs "APP?App token: " && echo && printf 'SLACK_BOT_TOKEN=%s\nSLACK_APP_TOKEN=%s\n' "$BOT" "$APP" >> .env && unset BOT APP
   ```
8. Verify. Every line must show ✓.
   ```bash
   npm run doctor -- --live
   ```
9. Run Ghost in the background. It starts at login and restarts after a crash. The log must show `Ghost is online`.
   ```bash
   scripts/service.sh install
   ```
   ```bash
   tail -n 5 data/ghost.log
   ```
10. **Human step.** In Slack, type `/invite @Ghost` in your personal channel and in each channel Ghost should read.

## Commands

| Command | Purpose |
| --- | --- |
| `scripts/service.sh install` / `uninstall` | Start or remove the background login item. |
| `scripts/service.sh restart` | Apply code or `.env` changes. |
| `scripts/service.sh logs` | Follow the log (`data/ghost.log`). |
| `npm run doctor` | Check tokens, scopes, database, and backend. |
| `npm test` | Run the tests. |

## Project map

| Path | Role |
| --- | --- |
| `src/index.ts` | Slack events (Socket Mode) and startup. |
| `src/pipeline/ghost.ts` | One question end to end: context, model call, reply. |
| `src/pipeline/prompt.ts` | System prompt and context packing. Edit the prompt here. |
| `src/pipeline/chat-channels.ts` | Decides where Ghost answers without a tag. |
| `src/retrieval/search.ts` | Search and ranking over the local index. |
| `src/store/` | SQLite index (`data/ghost.db`) and Slack sync. |
| `src/backend/` | `codex` and `claude` CLI calls (web search only, no shell or files). |
| `.env.example` | Every setting, with defaults. |

## Caution

Anyone in the workspace can tag `@Ghost`. Ghost then answers with your subscription and can quote any channel it is in, including private ones. Invite it only to channels you are comfortable with it repeating.
