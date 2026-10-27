# Grav Bot

An experimental community desktop studio for coordinating a team of AI specialists through Google's Antigravity CLI.

Built by Ian McLean with AI assistance. Inspired by the experience of coordinating a development team in Grok Bot; this is an independent project, with no affiliation with or endorsement by Google or xAI. It does not contain Grok's application, avatar engine, fonts, or model weights.

**Status: public developer preview.** Offline integration checks cover the app's main-process startup, seeded roster, CLI invocation, routing defaults, and workspace boundaries. Live model execution and a packaged public installer have not been validated for this release. This is not a verified feature-for-feature clone.

## What is here

- An Electron desktop shell with 21 example seats, including designers, an architect, QA, a librarian, and group rooms.
- Editable roles and prompts, persistent local conversations, reactions, and decision widgets.
- Drag-and-drop files and folders with working / not-working labels and local visual previews.
- Antigravity CLI integration and model settings per seat.
- Original lightweight SVG robot avatars and system fonts.
- Approximate token and cost displays. **These are estimates, not provider billing or a spending cap.** They omit hidden reasoning, tool calls, and subscription quota effects.

## Run from source on macOS

Requirements: Node.js 22 or later, npm, and a separately installed and signed-in Antigravity CLI (`agy`). See [Google Antigravity](https://antigravity.google/) for the provider's installation and account requirements.

```sh
git clone https://github.com/chromewizard/Grav_Bot.git
cd Grav_Bot
npm ci
npm start
```

Open the right-hand engine settings and verify the absolute path to `agy`. The default is `~/.local/bin/agy`, expanded for your account. Model IDs are inherited from the original studio and depend on your account; `agy models` lists what your installation offers.

The preview uses a separate **Grav Bot Public Preview** application-data directory. It does not load the original app's conversations. The workspace starts empty. To choose an existing project explicitly:

```sh
GRAV_BOT_WORKSPACE="/absolute/path/to/your/project" npm start
```

Optional environment settings: `GRAV_BOT_AGY_PATH` for the CLI executable, and `GRAV_BOT_DATA_DIR` for an alternate local data directory. Do not put private credentials or conversations in this repository.

## Usage and limits

Select a seat or group, type a message, and send. Sending invokes your Antigravity account and can consume quota or incur charges under your plan. No model runs on startup. Failed requests are not automatically retried with a second model.

Automatic cross-seat execution and restart resumption are off by default. A routed handoff is recorded in the destination conversation; send there explicitly to continue. The optional `autoRoute` setting in the local settings file enables bounded routing, which can still consume additional quota. There is no hard dollar budget enforcement.

The “Allow Bots to use local tools automatically” setting is off by default; CLI calls use sandbox and plan mode. Turning it on passes Antigravity's `--dangerously-skip-permissions` flag and can allow local changes through that account's configured tools. Keep this off until you understand the workspace and tool permissions.

The microphone button uses macOS Dictation. The original build's private language-server voice bridge is excluded. Voice availability depends on macOS configuration. Visual previews are sandboxed and may not behave identically to a full browser.

The desktop UI uses port **61558** on loopback for file previews. The public preview has no HTTP message-sending API. Use on a trusted local computer; it is not a network service or a hardened multi-user deployment.

## Verify

```sh
npm run check
npm test
```

Tests use a fake CLI and an isolated temporary workspace. They spend no model credits. See [release notes](docs/PUBLIC_PREVIEW.md) for the publication changes and remaining acceptance checks.

## Rights and attribution

The public tree contains the custom studio source and new original avatar code. No blanket open-source license has been selected for this initial preview. Public visibility does not grant a new license to third-party material or imply a Google/xAI endorsement. Electron is a separately installed dependency under its own license.
