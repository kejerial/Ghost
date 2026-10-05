# Ghost

Ghost is a personal Slack assistant. It runs on your Mac. It answers with your Slack history, the web, and the ChatGPT (Codex) or Claude subscription that you already pay for. It does not use metered API billing.

## What it does

- In a channel where you are the only human member, Ghost answers every message. You do not need to tag it.
- In other channels, tag `@Ghost`. Ghost replies in the thread.
- Ghost searches the history of every channel that it is in. It links each Slack message that it uses.
- Ghost searches the web and links articles and videos when they help.

## Set up

1. Install the dependencies.
```bash
npm install
```
2. Log in to a model CLI: `codex login` for ChatGPT, or `claude` then `/login` for Claude.
3. Install the [Slack CLI](https://docs.slack.dev/tools/slack-cli/), log in, and create the app from `manifest.json`.
```bash
slack login
```
```bash
slack app install -E deployed
```
4. Create `.env` from the example. Set `GHOST_BACKEND` to `codex` or `claude`.
```bash
cp .env.example .env
```
5. Open the app at <https://api.slack.com/apps> and add two tokens to `.env`:
   - `SLACK_BOT_TOKEN`: **OAuth & Permissions → Bot User OAuth Token**.
   - `SLACK_APP_TOKEN`: **Basic Information → App-Level Tokens**, with the `connections:write` scope.
6. Check the setup.
```bash
npm run doctor -- --live
```
7. Run Ghost in the background. It starts at every login and restarts after a crash.
```bash
scripts/service.sh install
```
8. In Slack, type `/invite @Ghost` in each channel that Ghost should read.

## Before you share a workspace with Ghost

Anyone in the workspace can tag `@Ghost`. Ghost then answers with your subscription, and it can quote any channel that Ghost is in, including private ones. Invite Ghost only to channels whose content you are comfortable with it repeating.

## Commands

| Command | Purpose |
| --- | --- |
| `scripts/service.sh install` | Run Ghost in the background. |
| `scripts/service.sh restart` | Restart after a code or `.env` change. |
| `scripts/service.sh logs` | Follow the log. |
| `scripts/service.sh uninstall` | Stop Ghost and remove the login item. |
| `npm start` | Run Ghost in this terminal. |
| `npm run doctor` | Check the tokens, scopes, database, and backend. |
| `npm test` | Run the tests. |

`.env.example` lists every setting.

## How it works

Ghost uses Slack Socket Mode, so it needs no public URL. It keeps a local SQLite index of the channels that it is in. For each question, it reads the thread and recent messages, searches the index, and sends that context to the `codex` or `claude` CLI. The CLI runs with web search only: no shell and no file access.
