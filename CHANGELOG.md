# Changelog

## Unreleased

- **"Call me and play this music" in one step.** `make_call` takes `say` (text, up to 600 characters, with `language` and `voice`) and `play` (a direct https `.mp3`/`.wav` link, or the name or id of a file in the audio library), plus `loop` (0..10, 0 = until hangup) and `order`. The hosted connector serves the call's VobizXML itself at `/c/:token/answer` (sealed `vbzs_` token, 20 minutes) and acknowledges `/c/:token/hangup`, so the call plays or speaks the content and then hangs up instead of dropping after the placeholder greeting. Library files get a fresh `/media/:token` link when the call is answered.
- `make_call` refuses page links (Pixabay, YouTube, Spotify, SoundCloud) for `play` with a clear message, refuses `say` / `play` together with `answer_url`, and lists the library when a name is not found. The result carries `script` and `how_to`; a call that falls back to the placeholder answer URL reports `script: { placeholder: true }`. The `/answer` placeholder itself is unchanged.
- `say` / `play` need the hosted connector for now; the stdio and single-account HTTP modes answer with `invalid_input` and keep working with your own `answer_url`.
- `import_audio_from_url` says it needs a direct link to an audio file, not a web page.

## 1.3.0

- **Your own audio on reminder calls.** Say "use this MP3 as my alarm" or "let me record the message", and the audio plays at the start of the call, before the spoken message. Each account has a private audio library. Add files on a one-time upload page (pick, drop or record from the microphone), by a direct upload from the assistant's code sandbox, or from a public https link. New tools: `create_audio_upload_link`, `import_audio_from_url`, `list_audio`, `delete_audio`. They are also part of the personal assistant sign-in.
- `schedule_reminder_call` takes `audio`: the name or id of a library file. It cannot be combined with `audio_url`. The result shows the chosen audio.
- Library files are converted for phone calls (8 kHz mono WAV, loudness-normalised) and kept in Google Cloud Storage (`VOBIZ_MEDIA_BUCKET`) or on local disk. Vobiz fetches them through short-lived sealed links, never public URLs. New routes: `GET`/`PUT /upload/:token` and `GET`/`HEAD /media/:token`.
- New settings: `VOBIZ_MEDIA_BUCKET`, `VOBIZ_MEDIA_DIR`, `VOBIZ_MEDIA_MAX_INPUT_MB`, `VOBIZ_MEDIA_MAX_DURATION_SEC`, `VOBIZ_MEDIA_MAX_PER_ACCOUNT` and `VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY`. The Docker image includes ffmpeg.

## 1.2.3

- Reminder-call XML uses `finishOnKey="none"` on the key-press prompt. The media server rejects an empty value, which ended calls before the message played.

## 1.2.2

- Reminder calls no longer use answering-machine detection, so a short "hello" can no longer cut the call before the message plays.
- `schedule_reminder_call` accepts `audio_url`: a public https MP3 or WAV played at the start of the call, before the spoken message.
- A failed job deletion on cancel is logged with its reason.

## 1.2.1

- Reminder lists no longer need a Firestore composite index, so a fresh deployment works without extra setup.
- Unexpected scheduler or store errors are logged (message only) instead of disappearing behind a generic error.

## 1.2.0

- **Reminder calls.** Ask your assistant "wake me up at 6 tomorrow" or "call me at 3 to remind me about the review". The hosted server schedules the call, speaks your message when you pick up, and lets you press 1 to snooze, 2 to confirm or 9 to stop. It calls again when there is no answer. New tools: `schedule_reminder_call`, `list_reminder_calls`, `get_reminder_call`, `cancel_reminder_call`.
- **Choose the access level at sign-in**: read-only, personal assistant (reminder calls to your own number only) or full access. The sign-in page also takes the number to call you on, the Vobiz number to call from, and your timezone.
- Durable scheduling on Google Cloud Tasks and Firestore when configured; otherwise in-process (single replica).
- ChatGPT readiness: RFC 9207 `iss` on authorization responses, ChatGPT origins and Client ID Metadata host, and `/.well-known/openai-apps-challenge` for domain verification.
- `@vobiz/mcp` is on npm and listed in the official MCP Registry as `io.github.vobiz-ai/vobiz-mcp`. Every local install snippet now uses `npx -y @vobiz/mcp@<version>`.
- **Connect in one step** for every MCP client: Claude, Claude Code, Codex, ChatGPT, Gemini CLI, Cursor, VS Code, Windsurf, Cline, Goose and more. Each connects to the hosted server with OAuth, so no Auth Token goes in a config file.
- A step-by-step guide to connecting Claude.
- A 512×512 Vobiz icon (PNG and SVG).

## 1.1.4

- First npm release of `@vobiz/mcp`. Releases are staged on npm and go live after maintainer 2FA approval. The new **MCP Registry** workflow then lists the server.
- `server.json` lists the hosted connector `https://mcp.vobiz.ai/mcp` as a remote.

## 1.1.3

- The hosted sign-in page returns you to your MCP client (Claude, Claude Code, Codex and others) right after **Allow access**.
- The sign-in page follows the Vobiz brand guidelines: IBM Plex Sans, Vobiz Red `#E83C00`, Orange `#E86A00` and Dark Grey `#100703`, the official lockup, and light and dark themes matching vobiz.ai.

## 1.1.2

- Every Vobiz link uses `https://www.vobiz.ai`, the canonical host. The docs page is now `https://www.vobiz.ai/docs/resources/vobiz-mcp`.
- `npm run test:live:remote` runs the OAuth sign-in, tools and token refresh against a deployed connector (default `https://mcp.vobiz.ai`).

## 1.1.1

- The bundled Vobiz Docs MCP server uses its canonical address, `https://www.vobiz.ai/docs/mcp`.

## 1.0.0

First public release, published as `@vobiz/mcp`.

**Added:**

- 49 more tools in four new toolsets:
  - conferences: list, inspect, end, member mute/deaf/kick/hangup/play, recording
  - media: live audio streams to wss:// agents, billing transactions, recording deletion, number release and sub-account assignment
  - sip: SIP endpoints, trunk credentials, IP allow-lists, origination URIs
  - subaccounts: CRUD, KYC status, hosted KYC session
- `VOBIZ_TOOLSETS` and `VOBIZ_READ_ONLY` to choose which tools the model sees; `--help` and `--version`.

- SMS, MMS and RCS tools: `send_message`, `preview_message_cost`, `list_messages`, `get_message`, `list_conversations`, `get_conversation_messages`, `list_messaging_numbers`, `list_broadcasts`, `get_broadcast`, `check_opt_out`, `list_opt_outs`, `add_opt_out`, `remove_opt_out`.
- The 15 Vobiz Agent Skills bundled as tools (`list_vobiz_skills`, `get_vobiz_skill`), prompts and `vobiz://skills/*` resources.
- A hosted multi-tenant connector (`vobiz-mcp hosted`, Docker). It includes OAuth 2.1 with PKCE, dynamic client registration and Client ID Metadata Documents; stateless sealed tokens; per-account limits; read-only consent; and Origin checks.
- Distribution: npm package with `bin`, an `.mcpb` desktop extension manifest, `server.json` for the MCP Registry, and release automation.

**Changed:**

- Every write tool is annotated `destructiveHint: true`, and every tool has a title.
- Balance tools use the account's own wallets (INR, USD and others). The default currency is no longer hard-coded.
- Destination countries are unrestricted by default (calling stays off until enabled). Product links are configurable.
- The server is renamed `vobiz` and the product name is spelled "Vobiz" throughout.
