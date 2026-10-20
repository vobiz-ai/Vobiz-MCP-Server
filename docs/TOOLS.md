# Vobiz MCP tool reference

Generated from the tool registry (110 tools). Regenerate with `npm run docs:tools`.

| Tool | Kind | Required inputs |
|---|---|---|
| `make_call` | **write, destructive** | `to`, `from`, `confirm` |
| `get_call_status` | read-only | `call_uuid` |
| `end_call` | **write, destructive** | `call_uuid`, `confirm` |
| `list_live_calls` | read-only | — |
| `send_dtmf` | **write, destructive** | `call_uuid`, `digits` |
| `transfer_call` | **write, destructive** | `call_uuid`, `confirm` |
| `hold_call` | **write, destructive** | `call_uuid`, `confirm` |
| `unhold_call` | **write, destructive** | `call_uuid`, `resume_url`, `confirm` |
| `play_audio` | **write, destructive** | `call_uuid`, `urls` |
| `stop_audio` | **write, destructive** | `call_uuid` |
| `speak_text` | **write, destructive** | `call_uuid`, `text` |
| `stop_speaking` | **write, destructive** | `call_uuid` |
| `start_recording` | **write, destructive** | `call_uuid`, `confirm` |
| `stop_recording` | **write, destructive** | `call_uuid` |
| `get_call_details` | read-only | `call_uuid` |
| `list_call_records` | read-only | — |
| `get_call_recording` | read-only | — |
| `list_recordings` | read-only | — |
| `list_phone_numbers` | read-only | — |
| `get_phone_number_details` | read-only | `phone_number` |
| `get_number_health` | read-only | `phone_number` |
| `get_account_details` | read-only | — |
| `get_account_balance` | read-only | — |
| `get_concurrency` | read-only | — |
| `list_sip_trunks` | read-only | — |
| `get_sip_trunk` | read-only | `trunk_id` |
| `generate_answer_xml` | read-only | `actions` |
| `gather_dtmf` | **write, destructive** | — |
| `get_gather_result` | read-only | `flow_id` |
| `list_webhook_events` | read-only | — |
| `list_webhooks` | read-only | — |
| `list_applications` | read-only | — |
| `get_application` | read-only | `app_id` |
| `create_application` | **write, destructive** | `app_name`, `answer_url`, `confirm` |
| `update_application` | **write, destructive** | `app_id`, `confirm` |
| `delete_application` | **write, destructive** | `app_id`, `confirm` |
| `search_available_numbers` | read-only | — |
| `buy_phone_number` | **write, destructive** | `phone_number`, `idempotency_key`, `confirm` |
| `update_phone_number` | **write, destructive** | `phone_number`, `confirm` |
| `create_sip_trunk` | **write, destructive** | `name`, `confirm` |
| `update_sip_trunk` | **write, destructive** | `trunk_id`, `confirm` |
| `delete_sip_trunk` | **write, destructive** | `trunk_id`, `confirm` |
| `send_message` | **write, destructive** | `from`, `to`, `idempotency_key`, `confirm` |
| `preview_message_cost` | read-only | `from`, `to` |
| `list_messages` | read-only | — |
| `get_message` | read-only | `message_id` |
| `list_conversations` | read-only | — |
| `get_conversation_messages` | read-only | `conversation_id` |
| `list_messaging_numbers` | read-only | — |
| `list_broadcasts` | read-only | — |
| `get_broadcast` | read-only | `broadcast_id` |
| `check_opt_out` | read-only | `phone_number` |
| `list_opt_outs` | read-only | — |
| `add_opt_out` | **write, destructive** | `phone_number`, `confirm` |
| `remove_opt_out` | **write, destructive** | `phone_number`, `confirm` |
| `list_conferences` | read-only | — |
| `get_conference` | read-only | `conference_name` |
| `end_conference` | **write, destructive** | `conference_name`, `confirm` |
| `end_all_conferences` | **write, destructive** | `confirm` |
| `mute_conference_member` | **write, destructive** | `conference_name`, `member_id` |
| `unmute_conference_member` | **write, destructive** | `conference_name`, `member_id` |
| `deafen_conference_member` | **write, destructive** | `conference_name`, `member_id` |
| `undeafen_conference_member` | **write, destructive** | `conference_name`, `member_id` |
| `kick_conference_member` | **write, destructive** | `conference_name`, `member_id`, `confirm` |
| `hangup_conference_member` | **write, destructive** | `conference_name`, `member_id`, `confirm` |
| `play_audio_to_conference_member` | **write, destructive** | `conference_name`, `member_id`, `url` |
| `stop_audio_to_conference_member` | **write, destructive** | `conference_name`, `member_id` |
| `start_conference_recording` | **write, destructive** | `conference_name`, `confirm` |
| `stop_conference_recording` | **write, destructive** | `conference_name` |
| `list_sip_endpoints` | read-only | — |
| `get_sip_endpoint` | read-only | `endpoint_id` |
| `create_sip_endpoint` | **write, destructive** | `username`, `password`, `alias`, `confirm` |
| `update_sip_endpoint` | **write, destructive** | `endpoint_id`, `confirm` |
| `delete_sip_endpoint` | **write, destructive** | `endpoint_id`, `confirm` |
| `list_trunk_credentials` | read-only | — |
| `create_trunk_credential` | **write, destructive** | `username`, `password`, `confirm` |
| `update_trunk_credential` | **write, destructive** | `credential_id`, `confirm` |
| `delete_trunk_credential` | **write, destructive** | `credential_id`, `confirm` |
| `list_ip_acl_entries` | read-only | — |
| `add_ip_acl_entry` | **write, destructive** | `name`, `ip_address`, `confirm` |
| `update_ip_acl_entry` | **write, destructive** | `ip_acl_id`, `name`, `ip_address`, `confirm` |
| `delete_ip_acl_entry` | **write, destructive** | `ip_acl_id`, `confirm` |
| `list_origination_uris` | read-only | — |
| `create_origination_uri` | **write, destructive** | `name`, `sip_uri`, `priority`, `confirm` |
| `update_origination_uri` | **write, destructive** | `uri_id`, `name`, `priority`, `confirm` |
| `delete_origination_uri` | **write, destructive** | `uri_id`, `confirm` |
| `start_audio_stream` | **write, destructive** | `call_uuid`, `service_url`, `confirm` |
| `list_audio_streams` | read-only | `call_uuid` |
| `get_audio_stream` | read-only | `call_uuid`, `stream_id` |
| `stop_audio_stream` | **write, destructive** | `call_uuid`, `stream_id` |
| `list_transactions` | read-only | — |
| `list_transaction_types` | read-only | — |
| `delete_recording` | **write, destructive** | `recording_id`, `confirm` |
| `release_phone_number` | **write, destructive** | `phone_number`, `confirm` |
| `cancel_number_release` | **write, destructive** | `phone_number`, `confirm` |
| `assign_number_to_subaccount` | **write, destructive** | `phone_number`, `sub_account_id`, `confirm` |
| `unassign_number_from_subaccount` | **write, destructive** | `phone_number`, `confirm` |
| `list_sub_accounts` | read-only | — |
| `get_sub_account` | read-only | `sub_auth_id` |
| `create_sub_account` | **write, destructive** | `name`, `confirm` |
| `update_sub_account` | **write, destructive** | `sub_auth_id`, `confirm` |
| `delete_sub_account` | **write, destructive** | `sub_auth_id`, `confirm` |
| `get_sub_account_kyc_status` | read-only | `sub_auth_id` |
| `create_sub_account_kyc_session` | **write, destructive** | `sub_auth_id`, `confirm` |
| `schedule_reminder_call` | **write, destructive** | `at`, `message`, `confirm` |
| `list_reminder_calls` | read-only | — |
| `get_reminder_call` | read-only | `reminder_id` |
| `cancel_reminder_call` | **write, destructive** | `reminder_id`, `confirm` |
| `list_vobiz_skills` | read-only | — |
| `get_vobiz_skill` | read-only | `name` |

## make_call

Initiate ONE outbound call through Vobiz (POST /Account/{auth_id}/Call/). Required: `to` (destination, E.164), `from` (caller ID: must be an active number on this account), and `confirm: true` after the user has explicitly approved this exact call. `answer_url` is required unless the server has VOBIZ_DEFAULT_ANSWER_URL configured; Vobiz fetches call-control XML from it when the call is answered. Success means Vobiz ACCEPTED/QUEUED the request and returned a request_uuid; it does NOT mean the call connected. Follow up with get_call_status using the returned request_uuid as call_uuid. Never call this twice for the same intent: if the outcome is unknown, check list_live_calls / list_call_records instead. Pass a unique idempotency_key per intended call: repeating a key replays the first result instead of dialling again. Server policy (enforced, not negotiable by the model): allowed destination countries, blocked prefixes, max duration, per-minute/hour caps, max concurrent calls, minimum balance.

| Input | Type | Required | Notes |
|---|---|---|---|
| `to` | string | yes | Destination number in E.164, e.g. +919876543210. One number only.; pattern `^\+?[1-9]\d{6,14}$` |
| `from` | string | yes | Caller ID: a Vobiz number on this account, E.164.; pattern `^\+?[1-9]\d{6,14}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly confirmed this call (destination and caller ID). |
| `answer_url` | string |  | URL that returns Vobiz XML when the call is answered. Defaults to the server's VOBIZ_DEFAULT_ANSWER_URL. |
| `answer_method` | `GET` | `POST` |  | HTTP method for answer_url (default POST). |
| `hangup_url` | string |  | URL notified when the call hangs up (defaults to answer_url). |
| `caller_name` | string |  | Caller name shown where supported (max 50 chars). |
| `time_limit` | integer |  | Maximum call duration in seconds. Defaults to, and may not exceed, the server's VOBIZ_MAX_CALL_DURATION_SEC.; min 1; max 86400 |
| `ring_timeout` | integer |  | Seconds to ring before giving up (default 120).; min 5; max 120 |
| `idempotency_key` | string |  | Unique key for this intended operation (e.g. a UUID). Repeating it replays the first result instead of acting again.; pattern `^[A-Za-z0-9_.:-]{8,128}$` |

## get_call_status

Return the current lifecycle state of one call: queued (accepted, not yet dialed), live (ringing / in-progress), or completed (from the call detail record). Use the request_uuid returned by make_call, or any call_uuid. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | Call UUID or the request_uuid from make_call.; pattern `^[A-Za-z0-9_-]{8,64}$` |

## end_call

Terminate an active or queued call (DELETE /Account/{auth_id}/Call/{call_uuid}/). Checks first that the call is live or queued on this account. Required: call_uuid and confirm: true after the user explicitly asked to end this call. Returns call_not_active if the call already ended.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | UUID of the call to end.; pattern `^[A-Za-z0-9_-]{8,64}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to end this call. |

## list_live_calls

List the UUIDs of calls currently in progress on this account, and optionally calls still queued. Read-only. Use get_call_status for details of one call.

| Input | Type | Required | Notes |
|---|---|---|---|
| `include_queued` | boolean |  | Also list queued (accepted, not yet dialed) calls. Default false. |

## send_dtmf

Send keypad tones on a LIVE call (POST /Account/{auth_id}/Call/{call_uuid}/DTMF/). Digits 0-9, *, #; `w` = 0.5s pause, `W` = 1s pause. Use only when the user asked to press keys on an active call (e.g. navigating an IVR).

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | UUID of the live call.; pattern `^[A-Za-z0-9_-]{8,64}$` |
| `digits` | string | yes | Digits to send, e.g. 1w2#; pattern `^[0-9*#wW]{1,64}$` |
| `legs` | `aleg` | `bleg` | `both` |  | Which call leg hears the tones (default aleg). |

## transfer_call

Blind-transfer a LIVE call (POST /Call/{uuid}/): Vobiz stops the current flow on the chosen leg and fetches new call XML. Give either `destination` (a phone number in E.164 or a sip: URI; the server hosts a <Dial> flow for it, HTTP mode only) or `aleg_url`/`bleg_url` (your own XML URL on an approved host). For an attended (warm) transfer, build the flow in VobizXML (for example hold music, then <Dial>). Requires confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `destination` | string |  | Number or SIP URI to connect the call to.; pattern `^(\+?[1-9]\d{6,14}|sip:[A-Za-z0-9_.+-]{1,64}@[A-Za-z0-9.-]{1,253})$` |
| `caller_id` | string |  | Caller ID for the transferred leg (a number on this account).; pattern `^\+?[1-9]\d{6,14}$` |
| `legs` | `aleg` | `bleg` | `both` |  | Which call leg: aleg (default), bleg or both. |
| `aleg_url` | string |  | XML URL for the A leg (approved host only). |
| `aleg_method` | `GET` | `POST` |  |  |
| `bleg_url` | string |  | XML URL for the B leg (approved host only). |
| `bleg_method` | `GET` | `POST` |  |  |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to transfer this call. |

## hold_call

Puts a leg on hold by transferring it to a hosted flow that plays hold music (or silence) in a loop. Resume with unhold_call and the XML URL that should take over. HTTP mode with VOBIZ_PUBLIC_URL only. Requires confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `legs` | `aleg` | `bleg` | `both` |  | Which call leg: aleg (default), bleg or both. |
| `music_url` | string |  | Hold music (https .mp3/.wav). Silence if omitted. |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to put this call on hold. |

## unhold_call

Takes a leg off emulated hold by transferring it to `resume_url` (XML on an approved host, e.g. a hosted flow from generate_answer_xml). Vobiz cannot return to the exact point the call was at before hold. Requires confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `resume_url` | string | yes | XML URL that should control the call after hold (approved host). |
| `legs` | `aleg` | `bleg` | `both` |  | Which call leg: aleg (default), bleg or both. |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to take this call off hold. |

## play_audio

Play one or more audio files (https .mp3/.wav) into a LIVE call (POST /Call/{uuid}/Play/). `mix: true` (default) plays over the conversation; false replaces it. Stop with stop_audio.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `urls` | array | yes | Audio files to play in order. |
| `legs` | `aleg` | `bleg` | `both` |  | Which call leg: aleg (default), bleg or both. |
| `loop` | boolean |  | Repeat until stopped. |
| `mix` | boolean |  | Mix with the call audio (default true). |
| `length` | integer |  | Stop after this many seconds.; min 1; max 3600 |

## stop_audio

Stop audio started by play_audio on a LIVE call (DELETE /Call/{uuid}/Play/).

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |

## speak_text

Read text aloud into a LIVE call with Vobiz text-to-speech (POST /Call/{uuid}/Speak/). voice WOMAN or MAN; language e.g. en-US, en-IN, hi-IN; type ssml for SSML markup. Stop with stop_speaking.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `text` | string | yes | Text (or SSML when type is ssml), max 3000 characters. |
| `voice` | `WOMAN` | `MAN` |  |  |
| `language` | `da-DK` | `nl-NL` | `en-AU` | `en-GB` | `en-US` | `en-IN` | `fr-FR` | `fr-CA` | `de-DE` | `it-IT` | `pl-PL` | `pt-PT` | `pt-BR` | `ru-RU` | `es-ES` | `es-US` | `sv-SE` | `hi-IN` |  | Default en-US. |
| `type` | `text` | `ssml` |  |  |
| `legs` | `aleg` | `bleg` | `both` |  | Which call leg: aleg (default), bleg or both. |
| `loop` | boolean |  |  |
| `mix` | boolean |  |  |

## stop_speaking

Stop text-to-speech started by speak_text on a LIVE call (DELETE /Call/{uuid}/Speak/).

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |

## start_recording

Start recording a LIVE call (POST /Call/{uuid}/Record/). Recording may require consent from the other party in your jurisdiction; confirm with the user first. Returns the recording_id/url Vobiz reports. Stop with stop_recording; find the file afterwards with get_call_recording. Requires confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `time_limit` | integer |  | Max seconds to record (Vobiz max 28800; default 60).; min 1; max 28800 |
| `file_format` | `mp3` | `wav` |  |  |
| `record_channel_type` | `mono` | `stereo` |  |  |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to record this call. |

## stop_recording

Stop recording on a LIVE call (DELETE /Call/{uuid}/Record/). Pass the recording `url` returned by start_recording to stop one recording; omit it to stop all recordings on the call.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `url` | string |  | Recording file URL from start_recording. |

## get_call_details

Return the full call detail record (CDR) of a COMPLETED call: direction, numbers, start/answer/end time, duration, billed seconds, hangup cause, cost, quality (MOS, jitter). For a call still in progress use get_call_status. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | UUID of the call.; pattern `^[A-Za-z0-9_-]{8,64}$` |

## list_call_records

List completed call records (CDRs) for this account, newest first, with pagination and a summary (total, answered, answer rate, duration, cost). Optional filters: start_date/end_date (YYYY-MM-DD, max 92 days apart), call_direction, from_number, to_number, hangup_cause, min/max duration. Filter by hangup_cause (e.g. NORMAL_CLEARING for answered, NO_ANSWER, USER_BUSY) to find answered, missed or busy calls. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `start_date` | string |  | Start of range, YYYY-MM-DD.; pattern `^\d{4}-\d{2}-\d{2}$` |
| `end_date` | string |  | End of range, YYYY-MM-DD (inclusive).; pattern `^\d{4}-\d{2}-\d{2}$` |
| `call_direction` | `inbound` | `outbound` |  |  |
| `from_number` | string |  | Caller number (partial match on the backend).; pattern `^\+?[1-9]\d{6,14}$` |
| `to_number` | string |  | Destination number (partial match on the backend).; pattern `^\+?[1-9]\d{6,14}$` |
| `hangup_cause` | string |  | pattern `^[A-Z_]{3,64}$` |
| `min_duration` | integer |  | Minimum duration in seconds.; min 0; max 9007199254740991 |
| `max_duration` | integer |  | Maximum duration in seconds.; min 0; max 9007199254740991 |
| `page` | integer |  | Page number (default 1).; min 1; max 10000 |
| `per_page` | integer |  | Records per page, max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).; min 1; max 100 |
| `include_summary` | boolean |  | Include the aggregate summary block (default true). |

## get_call_recording

Find the recording(s) of a call on this account and return their metadata and recording_url. Provide exactly one of call_uuid or recording_id. Not every call is recorded: an empty result means no recording exists. Recording URLs give access to call audio, so share them only with the account owner. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string |  | UUID of the call whose recordings to find.; pattern `^[A-Za-z0-9_-]{8,64}$` |
| `recording_id` | string |  | A specific recording ID.; pattern `^[A-Za-z0-9_-]{4,64}$` |

## list_recordings

List call recordings on this account (including its sub-accounts), newest first, with recording_url, call_uuid, numbers and duration. Optional from_date/to_date (YYYY-MM-DD). Vobiz returns at most 20 per page. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Recording URLs give access to call audio, so share them only with the account owner. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `from_date` | string |  | Earliest recording date, YYYY-MM-DD.; pattern `^\d{4}-\d{2}-\d{2}$` |
| `to_date` | string |  | Latest recording date, YYYY-MM-DD.; pattern `^\d{4}-\d{2}-\d{2}$` |
| `limit` | integer |  | Max 20 (Vobiz limit). Default 20.; min 1; max 20 |
| `offset` | integer |  | min 0; max 1000000 |

## list_phone_numbers

List the phone numbers on this Vobiz account (and its sub-accounts) with status, capabilities, linked application and fees. Supports status filter and search. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `status` | `active` | `pending_purchase` | `pending_release` | `released` | `blocked` | `quarantined` |  |  |
| `search` | string |  | Filter by (part of) a phone number.; pattern `^\+?\d{2,15}$` |
| `page` | integer |  | min 1; max 10000 |
| `per_page` | integer |  | Max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).; min 1; max 100 |

## get_phone_number_details

Return the details (status, capabilities, application, sub-account, fees, billing dates) of ONE phone number on this account. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | The number in E.164, e.g. +919876543210.; pattern `^\+?[1-9]\d{6,14}$` |

## get_number_health

Return usage and health of one phone number on this account: spam flag, usage status and daily/hourly call statistics (answer rate, failed calls, minutes). Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | The number in E.164.; pattern `^\+?[1-9]\d{6,14}$` |
| `granularity` | `daily` | `hourly` |  | Default daily. |
| `days` | integer |  | Days of history for daily granularity (default 30, max 90).; min 1; max 90 |

## get_account_details

Return this Vobiz account's profile: name, account type, status, CPS and concurrent-call limits, enabled features. Credentials are redacted. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|

## get_account_balance

Return the account balance: balance, available balance, reserved funds, credit limit and postpaid flag. Without `currency` it returns every wallet on the account (accounts can be billed in INR, USD or other currencies). Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `currency` | string |  | ISO currency code, e.g. INR or USD. Omit to list every wallet.; pattern `^[A-Za-z]{3}$` |

## get_concurrency

Return how many calls are running right now versus the account's maximum concurrent calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|

## list_sip_trunks

List SIP trunks on this account: name, domain, status, direction, CPS and concurrent-call limits. SIP credentials are redacted. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `direction` | `inbound` | `outbound` | `both` |  |  |
| `limit` | integer |  | Max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).; min 1; max 100 |
| `offset` | integer |  | min 0; max 9007199254740991 |

## get_sip_trunk

Return one SIP trunk's configuration (domain, status, direction, limits, transport, recording). SIP credentials are redacted. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `trunk_id` | string | yes | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |

## generate_answer_xml

Build a validated Vobiz XML document from a list of actions: speak, play, wait, gather (DTMF/speech), record, dial (number or sip_uri), redirect, hangup. Text is XML-escaped; callback/redirect URLs must be on approved hosts; actions after redirect/hangup are rejected. With host: true (HTTP mode) the server also serves it and returns a URL usable as make_call answer_url or transfer_call aleg_url. Pure generation otherwise (no API call).

| Input | Type | Required | Notes |
|---|---|---|---|
| `actions` | array | yes | Ordered actions, e.g. [{type:'speak',text:'Hello'},{type:'hangup'}] |
| `host` | boolean |  | Serve the XML from this server and return its URL (HTTP mode only). |

## gather_dtmf

Create a hosted IVR step that plays a prompt and collects DTMF digits (Vobiz <Gather>). Digits are posted back to this server, verified and stored; read them with get_gather_result. Give call_uuid (+ confirm: true) to move a LIVE call into it now (transfer), or use the returned url as make_call answer_url. HTTP mode with VOBIZ_PUBLIC_URL only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `prompt_text` | string |  | Spoken prompt, e.g. 'Press 1 for sales'. |
| `prompt_audio_url` | string |  | Or an https .mp3/.wav prompt. |
| `language` | string |  |  |
| `num_digits` | integer |  | min 1; max 32 |
| `execution_timeout` | integer |  | Seconds to wait for input (default 15).; min 5; max 60 |
| `digit_end_timeout` | integer|string |  |  |
| `finish_on_key` | `0` | `1` | `2` | `3` | `4` | `5` | `6` | `7` | `8` | `9` | `*` | `#` | `none` |  |  |
| `then` | array |  | XML actions to run after input is received (default: 'Thank you' and hang up). |
| `call_uuid` | string |  | Live call to move into this step now.; pattern `^[A-Za-z0-9_-]{8,64}$` |
| `confirm` | boolean |  | Required (true) with call_uuid: this replaces the live call's current flow. |

## get_gather_result

Return the DTMF input received for a gather_dtmf / hosted flow (digits, call_uuid, whether the callback signature was verified). Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `flow_id` | string | yes | pattern `^[0-9a-f]{32}$` |

## list_webhook_events

List callbacks Vobiz delivered to this server's /webhooks/vobiz endpoint and hosted flows (call answered/hung up, Gather digits, recording events), newest first. Duplicates are collapsed and unsigned/invalid requests are rejected per VOBIZ_WEBHOOK_SIGNATURE. HTTP mode only. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string |  | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `event` | string |  | e.g. StartApp, Hangup, Redirect; pattern `^[A-Za-z]{2,40}$` |
| `limit` | integer |  | min 1; max 200 |

## list_webhooks

Vobiz webhooks are configured on Applications (answer/hangup/fallback/message URLs, used for inbound calls on linked numbers) and on SIP trunks (webhook_url: CallInitiated and Hangup events, optional recording.completed). This lists all of them. Per-call URLs are set in make_call. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|

## list_applications

List Vobiz applications (answer/hangup URLs used for inbound calls on linked numbers). Max 20 per page (Vobiz limit). Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `app_name` | string |  | Filter: name contains |
| `limit` | integer |  | min 1; max 20 |
| `offset` | integer |  | min 0; max 9007199254740991 |

## get_application

Return one Vobiz application's configuration. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `app_id` | string | yes | pattern `^\d{5,25}$` |

## create_application

Create a Vobiz application (app_name and answer_url required). URLs must be on approved hosts. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `app_name` | string | yes |  |
| `answer_url` | string | yes |  |
| `answer_method` | `GET` | `POST` |  |  |
| `hangup_url` | string |  |  |
| `hangup_method` | `GET` | `POST` |  |  |
| `fallback_answer_url` | string |  |  |
| `fallback_method` | `GET` | `POST` |  |  |
| `default_number_app` | boolean |  |  |
| `default_endpoint_app` | boolean |  |  |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: creating this application. |

## update_application

Change a Vobiz application's URLs or flags. Note: Vobiz resets default_endpoint_app to false when it is omitted, so this tool re-sends its current value. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `app_id` | string | yes | pattern `^\d{5,25}$` |
| `app_name` | string |  |  |
| `answer_url` | string |  | XML URL fetched when a call reaches a number linked to this application (approved host). |
| `answer_method` | `GET` | `POST` |  |  |
| `hangup_url` | string |  |  |
| `hangup_method` | `GET` | `POST` |  |  |
| `fallback_answer_url` | string |  |  |
| `fallback_method` | `GET` | `POST` |  |  |
| `default_number_app` | boolean |  |  |
| `default_endpoint_app` | boolean |  |  |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: changing this application. |

## delete_application

Delete a Vobiz application. Linked numbers are unlinked (inbound calls to them stop being handled). Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `app_id` | string | yes | pattern `^\d{5,25}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: deleting this application. |

## search_available_numbers

Search Vobiz inventory for numbers available to buy, with setup/monthly fees. Filters: country (e.g. IN), region, contains (digits), series (Indian number series after +91). Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `country` | string |  | pattern `^[A-Z]{2}$` |
| `region` | string |  |  |
| `contains` | string |  | Digits the number must contain (vanity/pattern search).; pattern `^\d{1,15}$` |
| `series` | string |  | India only: digits right after +91, e.g. 80.; pattern `^\d{1,6}$` |
| `page` | integer |  | min 1; max 10000 |
| `per_page` | integer |  | min 1; max 100 |

## buy_phone_number

Buy one number from Vobiz inventory (POST /numbers/purchase-from-inventory). This charges setup + monthly fee immediately. Server checks: provisioning enabled, the number is in inventory, cost within VOBIZ_MAX_NUMBER_COST, enough balance, daily purchase cap, not already owned. Requires confirm: true (after showing the user the number and its fees) and an idempotency_key; repeating the key never buys twice.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | Number from search_available_numbers, E.164.; pattern `^\+?[1-9]\d{6,14}$` |
| `currency` | string |  | pattern `^[A-Z]{3}$` |
| `idempotency_key` | string | yes | Unique key for this intended operation (e.g. a UUID). Repeating it replays the first result instead of acting again.; pattern `^[A-Za-z0-9_.:-]{8,128}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: buying this number at the quoted fees. |

## update_phone_number

Change one owned number's configuration: replace its tags, link it to an application (inbound calls run that app's answer_url) or to a SIP trunk, or unlink them. A number can be linked to an application OR a trunk, not both. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | pattern `^\+?[1-9]\d{6,14}$` |
| `tags` | array |  |  |
| `application_id` | string |  | pattern `^\d{5,25}$` |
| `unlink_application` | boolean |  |  |
| `trunk_id` | string |  | Trunk to route this number to (sent as trunk_group_id).; pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `unlink_trunk` | boolean |  |  |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: changing this number's routing. |

## create_sip_trunk

Create a SIP trunk (POST /trunks). Authenticate with credential_uuid and/or ipacl_uuid; route outbound via primary_uri_uuid with fallback_uri_uuid for failover. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `trunk_status` | `enabled` | `disabled` |  |  |
| `trunk_direction` | `inbound` | `outbound` | `both` |  |  |
| `secure` | boolean |  |  |
| `transport` | `udp` | `tcp` | `tls` |  |  |
| `concurrent_calls_limit` | integer |  | min 1; max 1000 |
| `cps_limit` | integer |  | min 1; max 100 |
| `credential_uuid` | string |  | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `ipacl_uuid` | string |  | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `primary_uri_uuid` | string |  | Origination URI used first (failover order: primary, then fallback).; pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `fallback_uri_uuid` | string |  | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `inbound_destination` | string |  |  |
| `description` | string |  |  |
| `recording` | boolean |  |  |
| `enable_transcription` | boolean |  |  |
| `webhook_url` | string |  | Receives CallInitiated and Hangup events (public https). |
| `webhook_method` | `GET` | `POST` |  |  |
| `recording_webhook_enabled` | boolean |  |  |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: creating this SIP trunk. |

## update_sip_trunk

Change a SIP trunk's settings (PUT /trunks/{id}), including limits, auth references, failover URIs, recording and webhook_url. Only the fields you pass change. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `trunk_id` | string | yes | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `name` | string |  |  |
| `trunk_status` | `enabled` | `disabled` |  |  |
| `trunk_direction` | `inbound` | `outbound` | `both` |  |  |
| `secure` | boolean |  |  |
| `transport` | `udp` | `tcp` | `tls` |  |  |
| `concurrent_calls_limit` | integer |  | min 1; max 1000 |
| `cps_limit` | integer |  | min 1; max 100 |
| `credential_uuid` | string |  | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `ipacl_uuid` | string |  | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `primary_uri_uuid` | string |  | Origination URI used first (failover order: primary, then fallback).; pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `fallback_uri_uuid` | string |  | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `inbound_destination` | string |  |  |
| `description` | string |  |  |
| `recording` | boolean |  |  |
| `enable_transcription` | boolean |  |  |
| `webhook_url` | string |  | Receives CallInitiated and Hangup events (public https). |
| `webhook_method` | `GET` | `POST` |  |  |
| `recording_webhook_enabled` | boolean |  |  |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: changing this SIP trunk. |

## delete_sip_trunk

Delete a SIP trunk (soft delete). Numbers routed to it are unlinked and stop receiving calls through it. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `trunk_id` | string | yes | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: deleting this SIP trunk. |

## send_message

Send a real SMS, MMS or RCS message through Vobiz (POST /api/v1/sms/messages). Each recipient becomes its own message and is billed. Required: `from`, `to`, `idempotency_key`, and `confirm: true` after the user approved the exact sender, recipients and text. For sms/mms, `from` is one of your Vobiz messaging numbers (see list_messaging_numbers); for rcs it is your RCS sender name. Use preview_message_cost first to show the price and segment count. Opted-out recipients are refused by Vobiz (opted_out). status `scheduled` = held until scheduled_at; `sent` = handed to the network; delivery receipts update it to `delivered` or `failed` (check get_message). Repeating an idempotency_key never sends twice.

| Input | Type | Required | Notes |
|---|---|---|---|
| `from` | string | yes | Sender: an E.164 Vobiz messaging number (sms/mms), or your RCS sender name (rcs). |
| `to` | array | yes | Recipient numbers in E.164, e.g. ['+14155550123']. Capped by VOBIZ_MAX_RECIPIENTS_PER_SEND. |
| `text` | string |  | Message body. Required for sms and rcs. Long SMS are split into billed segments. |
| `channel` | `sms` | `mms` | `rcs` |  | sms (default), mms or rcs. |
| `media_urls` | array |  | Public https media URLs (MMS up to 10; RCS sends the first). |
| `title` | string |  | MMS subject line. |
| `scheduled_at` | string |  | Send later at this RFC 3339 time, e.g. 2026-11-01T09:00:00Z.; pattern `^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$` |
| `failover_to_sms` | boolean |  | RCS only: send the text as SMS if RCS cannot be delivered. |
| `tag` | string |  | Your label, stored on every message; filter list_messages by it. |
| `dlt_entity_id` | string |  | India TRAI DLT Principal Entity ID. |
| `dlt_header_id` | string |  | India TRAI DLT sender header ID. |
| `dlt_template_id` | string |  | India TRAI DLT content template ID; text must match it. |
| `idempotency_key` | string | yes | Unique key for this intended operation (e.g. a UUID). Repeating it replays the first result instead of acting again.; pattern `^[A-Za-z0-9_.:-]{8,128}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved this send. |

## preview_message_cost

Price one message before sending: segment count, unit cost, total cost and currency for a sender, recipient and text (GET /api/v1/sms/messages/cost-preview). Sends nothing. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `from` | string | yes | Your Vobiz messaging number, E.164.; pattern `^\+?[1-9]\d{6,14}$` |
| `to` | string | yes | Recipient, E.164.; pattern `^\+?[1-9]\d{6,14}$` |
| `text` | string |  | Message body; its length decides the segment count. |
| `channel` | `sms` | `mms` |  | sms (default) or mms. |

## list_messages

List SMS, MMS and RCS messages on this account, newest first, with filters (status, channel, direction in/out, to, from, tag, date range) and limit/offset paging. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `status` | `scheduled` | `sent` | `delivered` | `failed` | `received` | `unknown` |  |  |
| `channel` | `sms` | `mms` | `rcs` |  |  |
| `direction` | `in` | `out` |  | in = received, out = sent. |
| `to` | string |  | pattern `^\+?[1-9]\d{6,14}$` |
| `from` | string |  |  |
| `tag` | string |  |  |
| `start_date` | string |  | Created at or after, ISO 8601.; pattern `^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$` |
| `end_date` | string |  | Created at or before, ISO 8601.; pattern `^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$` |
| `limit` | integer |  | Page size, 1-100 (default 20).; min 1; max 100 |
| `offset` | integer |  | min 0; max 1000000 |

## get_message

Return one message by ID with its current status, error details and status history (sent → delivered / failed). Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `message_id` | string | yes | pattern `^[A-Za-z0-9_-]{6,64}$` |

## list_conversations

List message threads (one per pair of numbers and channel), most recently active first, with message and unread counts. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer |  | Page size, 1-100 (default 20).; min 1; max 100 |
| `offset` | integer |  | min 0; max 1000000 |

## get_conversation_messages

Return the messages of one conversation (from list_conversations or a message's conversationId), oldest first. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conversation_id` | string | yes | Conversation ID.; pattern `^[A-Za-z0-9_-]{6,64}$` |
| `limit` | integer |  | Page size, 1-100 (default 50).; min 1; max 100 |
| `offset` | integer |  | min 0; max 1000000 |

## list_messaging_numbers

List the numbers on this account that can send and receive SMS/MMS, with capabilities and their latest message. Use one as send_message `from`. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|

## list_broadcasts

List bulk-message broadcasts on this account with status (draft, scheduled, running, paused, completed, cancelled) and delivery stats. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer |  | Page size, 1-500 (default 50).; min 1; max 500 |
| `offset` | integer |  | min 0; max 1000000 |

## get_broadcast

Return one broadcast with its template, schedule, send rate and stats (total, sent, delivered, failed). Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `broadcast_id` | string | yes | Broadcast ID.; pattern `^[A-Za-z0-9_-]{6,64}$` |

## check_opt_out

Check whether a phone number has opted out of messages on a channel. Vobiz refuses sends to opted-out numbers. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | pattern `^\+?[1-9]\d{6,14}$` |
| `channel` | `sms` | `mms` | `rcs` |  | sms (default; also covers mms), mms or rcs. |

## list_opt_outs

List numbers that opted out (by STOP keyword or added manually), with channel, reason and source. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer |  | Page size, 1-100 (default 20).; min 1; max 100 |
| `offset` | integer |  | min 0; max 1000000 |

## add_opt_out

Block a phone number from receiving messages on a channel (for example after a customer asks to stop). Requires confirm: true and VOBIZ_ENABLE_MESSAGING=true. Safe to repeat.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | pattern `^\+?[1-9]\d{6,14}$` |
| `channel` | `sms` | `mms` | `rcs` |  | sms (default; also covers mms), mms or rcs. |
| `reason` | string |  | Note stored on the record, e.g. 'customer request'. |
| `confirm` | boolean | yes | Must be true after the user approved blocking this number. |

## remove_opt_out

Allow messages to a number again. Only do this when the person has explicitly opted back in (for example by texting START); messaging someone who opted out breaks consent rules. Requires confirm: true and VOBIZ_ENABLE_MESSAGING=true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | pattern `^\+?[1-9]\d{6,14}$` |
| `channel` | `sms` | `mms` | `rcs` |  | sms (default; also covers mms), mms or rcs. |
| `confirm` | boolean | yes | Must be true after the user confirmed this person opted back in. |

## list_conferences

List the names of conference rooms currently running on this Vobiz account (GET /Conference/). Use it to find a room before inspecting it with get_conference or controlling its members. Keep a record of the rooms you start so you can check or end each one by name with get_conference and end_conference.

| Input | Type | Required | Notes |
|---|---|---|---|

## get_conference

Get one running Vobiz conference room by name (GET /Conference/{name}/): run time, member count and each member's member_id, call_uuid, caller, mute and deaf state. Use it to find the member_id values that the mute, deafen, kick, hang-up and play tools need.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |

## end_conference

Hang up one running Vobiz conference room (DELETE /Conference/{name}/): every member is disconnected at once and the room ends. Use it to close a meeting on time or clean up an abandoned room; to remove only some people, use kick_conference_member or hangup_conference_member. Requires confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to end this conference for everyone in it. |

## end_all_conferences

Hang up EVERY running conference room on this Vobiz account at once (DELETE /Conference/): all members of all rooms are disconnected. Use it only for account-wide cleanup or maintenance; to close one room, use end_conference. Requires confirm: true after the user explicitly agrees to end all conferences.

| Input | Type | Required | Notes |
|---|---|---|---|
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to end every live conference on the account. |

## mute_conference_member

Mute one or more members of a live Vobiz conference (POST /Conference/{name}/Member/{id}/Mute/) so others cannot hear them; they still hear the room. Pass one member_id, a comma-separated list, or all (for example presenter mode). Undo with unmute_conference_member.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `member_id` | string | yes | ConferenceMemberID from the ConferenceEnter callback (or get_conference), a comma-separated list such as 17,45,82, or `all` for every member.; pattern `^(all|\d{1,10}(,\d{1,10}){0,49})$` |

## unmute_conference_member

Unmute members of a live Vobiz conference (DELETE /Conference/{name}/Member/{id}/Mute/) so the room can hear them again. Pass one member_id, a comma-separated list, or all. Unmuting a member who is not muted still succeeds.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `member_id` | string | yes | ConferenceMemberID from the ConferenceEnter callback (or get_conference), a comma-separated list such as 17,45,82, or `all` for every member.; pattern `^(all|\d{1,10}(,\d{1,10}){0,49})$` |

## deafen_conference_member

Deafen members of a live Vobiz conference (POST /Conference/{name}/Member/{id}/Deaf/) so they stop hearing the room; others still hear them. Use it for listen-only setups or private side conversations. Pass one member_id, a comma-separated list, or all. Undo with undeafen_conference_member.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `member_id` | string | yes | ConferenceMemberID from the ConferenceEnter callback (or get_conference), a comma-separated list such as 17,45,82, or `all` for every member.; pattern `^(all|\d{1,10}(,\d{1,10}){0,49})$` |

## undeafen_conference_member

Let deafened members of a live Vobiz conference hear the room again (DELETE /Conference/{name}/Member/{id}/Deaf/). Pass one member_id, a comma-separated list, or all. Undeafening a member who is not deafened still succeeds.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `member_id` | string | yes | ConferenceMemberID from the ConferenceEnter callback (or get_conference), a comma-separated list such as 17,45,82, or `all` for every member.; pattern `^(all|\d{1,10}(,\d{1,10}){0,49})$` |

## kick_conference_member

Remove members from a live Vobiz conference while keeping their call up (POST /Conference/{name}/Member/{id}/Kick/): their call continues with the next VobizXML element after <Conference>, so you can play them a message or route them elsewhere. To end their call instead, use hangup_conference_member. Pass one member_id, a comma-separated list, or all. Requires confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `member_id` | string | yes | ConferenceMemberID from the ConferenceEnter callback (or get_conference), a comma-separated list such as 17,45,82, or `all` for every member.; pattern `^(all|\d{1,10}(,\d{1,10}){0,49})$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to remove this member from the conference. |

## hangup_conference_member

End the calls of members in a live Vobiz conference (DELETE /Conference/{name}/Member/{id}/): they leave the room and their call hangs up. Use it to drop a participant completely; to keep their call going after they leave, use kick_conference_member. Pass one member_id, a comma-separated list, or all. Requires confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `member_id` | string | yes | ConferenceMemberID from the ConferenceEnter callback (or get_conference), a comma-separated list such as 17,45,82, or `all` for every member.; pattern `^(all|\d{1,10}(,\d{1,10}){0,49})$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to hang up this member's call. |

## play_audio_to_conference_member

Play an audio file (https .mp3/.wav) privately to members of a live Vobiz conference (POST /Conference/{name}/Member/{id}/Play/); other members do not hear it. Use it for whispered prompts or announcements, or pass member_id all to reach the whole room. Stop with stop_audio_to_conference_member.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `member_id` | string | yes | ConferenceMemberID from the ConferenceEnter callback (or get_conference), a comma-separated list such as 17,45,82, or `all` for every member.; pattern `^(all|\d{1,10}(,\d{1,10}){0,49})$` |
| `url` | string | yes | Audio file to play (https .mp3 or .wav). |

## stop_audio_to_conference_member

Stop audio started by play_audio_to_conference_member for members of a live Vobiz conference (DELETE /Conference/{name}/Member/{id}/Play/). Pass one member_id, a comma-separated list, or all. It succeeds even when nothing is playing.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `member_id` | string | yes | ConferenceMemberID from the ConferenceEnter callback (or get_conference), a comma-separated list such as 17,45,82, or `all` for every member.; pattern `^(all|\d{1,10}(,\d{1,10}){0,49})$` |

## start_conference_recording

Start recording the mixed audio of a live Vobiz conference room (POST /Conference/{name}/Record/) in mp3 (default) or wav. Recording may require consent from every participant in your jurisdiction, so confirm with the user first (consider announcing it). Vobiz queues the recording; the reply carries no recording ID or file URL. Stop with stop_conference_recording. Requires confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |
| `file_format` | `mp3` | `wav` |  | Recording format (default mp3). |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly asked to record this conference. |

## stop_conference_recording

Stop the recording of a live Vobiz conference room (DELETE /Conference/{name}/Record/). Use it when the part you needed is captured; the conference itself keeps running.

| Input | Type | Required | Notes |
|---|---|---|---|
| `conference_name` | string | yes | Conference room name, exactly as used in the <Conference> XML element.; pattern `^[A-Za-z0-9][A-Za-z0-9 _.@:+-]{0,127}$` |

## list_sip_endpoints

List the SIP endpoints on this Vobiz account: soft-phones, desk phones and WebRTC clients that register at registrar.vobiz.ai. Shows each endpoint's username, alias, SIP URI, attached application and registration state. Filter by username, alias, application or sub-account. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only. Passwords are never shown here. The user can view or reset them in the Vobiz console.

| Input | Type | Required | Notes |
|---|---|---|---|
| `username_contains` | string |  | Filter: username contains this text.; pattern `^[A-Za-z0-9_]{1,64}$` |
| `alias_contains` | string |  | Filter: alias contains this text. |
| `application_id` | string |  | Filter: endpoints attached to this application.; pattern `^\d{5,25}$` |
| `without_application` | boolean |  | true = only endpoints with no application attached. |
| `sub_account` | string |  | Filter: endpoints of this sub-account.; pattern `^SA_[A-Za-z0-9]{4,40}$` |
| `limit` | integer |  | Max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).; min 1; max 100 |
| `offset` | integer |  | min 0; max 9007199254740991 |

## get_sip_endpoint

Return one Vobiz SIP endpoint: username, alias, SIP URI, attached application and, when a device is registered, its registration details (contact, expiry, user agent). Use it to check whether a soft-phone or WebRTC client is online. Read-only. Passwords are never shown here. The user can view or reset them in the Vobiz console.

| Input | Type | Required | Notes |
|---|---|---|---|
| `endpoint_id` | string | yes | pattern `^\d{4,25}$` |

## create_sip_endpoint

Create a Vobiz SIP endpoint so a soft-phone, desk phone or WebRTC client can register at registrar.vobiz.ai with its own username and password. Attach an application to handle its calls (otherwise the account's default endpoint application applies, if set). The username cannot be changed later. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true. The password is write-only and never returned.

| Input | Type | Required | Notes |
|---|---|---|---|
| `username` | string | yes | SIP username, unique on the account and permanent. Letters and digits are safest.; pattern `^[A-Za-z0-9_]{3,64}$` |
| `password` | string | yes | SECRET: the endpoint's SIP password (8+ characters; 12+ with mixed case, digits and symbols recommended). It is sent to Vobiz once and never shown again. |
| `alias` | string | yes | Friendly name, e.g. Front desk phone.; pattern `^[A-Za-z0-9 _'.-]{1,100}$` |
| `application_id` | string |  | Application that handles this endpoint's calls (sent as `application`).; pattern `^\d{5,25}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: creating this SIP endpoint. |

## update_sip_endpoint

Change a Vobiz SIP endpoint's alias, password, attached application or voice/message/video permissions. Only the fields you pass change; the username is permanent. A new password signs out every registered device until it re-registers. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `endpoint_id` | string | yes | pattern `^\d{4,25}$` |
| `alias` | string |  | pattern `^[A-Za-z0-9 _'.-]{1,100}$` |
| `password` | string |  | SECRET: the endpoint's new SIP password (8+ characters; 12+ with mixed case, digits and symbols recommended). It is sent to Vobiz once and never shown again. |
| `application_id` | string |  | Application that should handle this endpoint's calls (sent as `application`).; pattern `^\d{5,25}$` |
| `allow_voice` | boolean |  |  |
| `allow_message` | boolean |  |  |
| `allow_video` | boolean |  |  |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: changing this SIP endpoint. |

## delete_sip_endpoint

Permanently delete a Vobiz SIP endpoint. Devices registered with it disconnect immediately and its SIP URI stops working. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `endpoint_id` | string | yes | pattern `^\d{4,25}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: deleting this SIP endpoint. |

## list_trunk_credentials

List the SIP digest credentials on this Vobiz account that trunks use to authenticate a PBX, carrier or voice agent: username, realm and enabled state. Use the credential id as credential_uuid on a trunk. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only. Passwords are never shown here. The user can view or reset them in the Vobiz console.

| Input | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer |  | Max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).; min 1; max 100 |
| `offset` | integer |  | min 0; max 9007199254740991 |

## create_trunk_credential

Create a SIP digest credential (username and password) on this Vobiz account for trunk authentication, for dynamic-IP PBXs, remote sites or voice agents. Attach it to a trunk afterwards with update_sip_trunk (credential_uuid). The username is permanent. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true. The password is write-only and never returned.

| Input | Type | Required | Notes |
|---|---|---|---|
| `username` | string | yes | SIP username, unique on the account and permanent. Letters and digits are safest.; pattern `^[A-Za-z0-9_]{3,64}$` |
| `password` | string | yes | SECRET: the trunk credential's SIP password (8+ characters; 12+ with mixed case, digits and symbols recommended). It is sent to Vobiz once and never shown again. |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: creating this trunk credential. |

## update_trunk_credential

Rotate a trunk credential's password, enable or disable it, or change its description on Vobiz. The username is permanent; to rename, create a new credential and delete the old one. A new password takes effect for the next SIP authentication. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `credential_id` | string | yes | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `password` | string |  | SECRET: the trunk credential's new SIP password (8+ characters; 12+ with mixed case, digits and symbols recommended). It is sent to Vobiz once and never shown again. |
| `enabled` | boolean |  | false pauses authentication with this credential without deleting it. |
| `description` | string |  |  |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: changing this trunk credential. |

## delete_trunk_credential

Delete a trunk credential from this Vobiz account. Any PBX or device authenticating with it is refused from then on; Vobiz may refuse while it is in use by active calls. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `credential_id` | string | yes | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: deleting this trunk credential. |

## list_ip_acl_entries

List the IP access control entries on this Vobiz account: the IPv4 addresses and CIDR ranges allowed to send SIP traffic to trunks without digest credentials. Use it to audit which PBXs, SBCs or carriers are trusted. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer |  | Max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).; min 1; max 100 |
| `offset` | integer |  | min 0; max 9007199254740991 |

## add_ip_acl_entry

Allow-list a public IPv4 address or CIDR range (e.g. 198.51.100.42 or 10.20.30.0/24) so a static-IP PBX, SBC or carrier can use Vobiz trunks without digest credentials. Attach it to a trunk with update_sip_trunk (ipacl_uuid). Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Label, e.g. Office PBX. Returned as `description`. |
| `ip_address` | string | yes | IPv4 address or IPv4 CIDR block. |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: allow-listing this IP address for SIP traffic. |

## update_ip_acl_entry

Replace a Vobiz IP ACL entry's label and address. Both name and ip_address are required on every update; resend the current value of the one you keep. Traffic from the old address stops being trusted. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `ip_acl_id` | string | yes | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `name` | string | yes | Label for the entry (resend the current one to keep it). |
| `ip_address` | string | yes | IPv4 address or IPv4 CIDR block (resend the current one to keep it). |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: changing this IP ACL entry. |

## delete_ip_acl_entry

Remove an IP ACL entry from this Vobiz account. SIP traffic from that address or range is no longer trusted and needs other authentication. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `ip_acl_id` | string | yes | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: deleting this IP ACL entry. |

## list_origination_uris

List the origination URIs on this Vobiz account: the SIP destinations trunks deliver outbound calls to, with priority (failover order), weight (load split), transport and enabled state. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer |  | Max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).; min 1; max 100 |
| `offset` | integer |  | min 0; max 9007199254740991 |

## create_origination_uri

Add a SIP destination (origination URI) such as sip:sbc.example.com:5060 that Vobiz trunks route outbound calls to. Use priority 1 for the primary and 2+ for failover; attach it to a trunk with update_sip_trunk (primary_uri_uuid or fallback_uri_uuid). The host must be public. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Label, e.g. Primary SBC. Returned as `description`. |
| `sip_uri` | string | yes | sip:host, sip:host:port, sip:user@host or sip:user@host:port. Returned as `uri`. |
| `priority` | integer | yes | Routing priority: lower is tried first (1 = primary, 2+ = failover).; min 1; max 1000 |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: adding this outbound SIP destination. |

## update_origination_uri

Replace a Vobiz origination URI's label and priority, for example to promote a failover destination to primary. Both name and priority are required; resend the current value you keep. To point at a different host, create a new origination URI and delete this one; weight and enabled are managed in the Vobiz console. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `uri_id` | string | yes | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `name` | string | yes | Label (resend the current one to keep it). |
| `priority` | integer | yes | Routing priority: lower is tried first (1 = primary, 2+ = failover).; min 1; max 1000 |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: changing this origination URI. |

## delete_origination_uri

Delete an origination URI from this Vobiz account. Trunks stop routing outbound calls to that destination; add a replacement first if it is a trunk's only route. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `uri_id` | string | yes | pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: deleting this origination URI. |

## start_audio_stream

Fork the audio of a LIVE Vobiz call to your WebSocket server in near real time (POST /Call/{uuid}/Stream/), for example for live transcription or an AI voice agent. service_url must be wss:// on an approved host. bidirectional: true lets your server play audio back into the call and requires audio_track inbound (the default when bidirectional). content_type sets the inbound audio format (L16 8 kHz default, L16 16 kHz, or mu-law 8 kHz). Returns a stream_id for get_audio_stream / stop_audio_stream. This sends live call audio to an external server, so it requires confirm: true after the user approves the destination.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `service_url` | string | yes | wss:// URL of your WebSocket server (approved host). |
| `bidirectional` | boolean |  | Allow your server to send audio back into the call (playAudio). Default false. |
| `audio_track` | `inbound` | `outbound` | `both` |  | Which audio to fork. Default both; must be inbound when bidirectional is true. |
| `content_type` | `audio/x-l16;rate=8000` | `audio/x-l16;rate=16000` | `audio/x-mulaw;rate=8000` |  | Inbound audio format sent to your server. Default audio/x-l16;rate=8000. |
| `stream_timeout` | integer |  | Stop the stream automatically after this many seconds. Default 86400.; min 1; max 86400 |
| `status_callback_url` | string |  | https URL (approved host) that receives stream status events (StartStream, PlayedStream, StopStream...). |
| `status_callback_method` | `GET` | `POST` |  | Default POST. |
| `extra_headers` | string |  | Comma-separated header:value pairs (e.g. X-Session:abc123) passed with the stream. Use the wss:// URL path, not these headers, to authenticate the socket.; pattern `^[A-Za-z0-9-]{1,64}:[^,\r\n]{1,256}(,[A-Za-z0-9-]{1,64}:[^,\r\n]{1,256})*$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: sending this call's live audio to this WebSocket server. |

## list_audio_streams

List the audio streams on a Vobiz call (GET /Call/{uuid}/Stream/), both active and stopped, with status, WebSocket URL, track and audio format. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `limit` | integer |  | Default 20.; min 1; max 100 |
| `offset` | integer |  | min 0; max 100000 |

## get_audio_stream

Return one audio stream on a Vobiz call (GET /Call/{uuid}/Stream/{stream_id}/): status, WebSocket URL, track, audio format, start and end time. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `stream_id` | string | yes | pattern `^[A-Za-z0-9_-]{4,64}$` |

## stop_audio_stream

Stop one audio stream on a LIVE Vobiz call (DELETE /Call/{uuid}/Stream/{stream_id}/). Other streams on the call keep running, and the call itself continues.

| Input | Type | Required | Notes |
|---|---|---|---|
| `call_uuid` | string | yes | pattern `^[A-Za-z0-9_-]{8,64}$` |
| `stream_id` | string | yes | pattern `^[A-Za-z0-9_-]{4,64}$` |

## list_transactions

List this Vobiz account's billing ledger, newest first: call charges, number rentals, recharges and adjustments, with a summary of total debit/credit over the whole filtered set. Filters: from_date/to_date (inclusive; YYYY-MM-DD is a whole UTC day, or pass an ISO timestamp with offset), type (credit/debit or an exact type), status, currency, reference_type (see list_transaction_types), description/reference (substring) and transaction_id. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `from_date` | string |  | pattern `^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$` |
| `to_date` | string |  | pattern `^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$` |
| `type` | string |  | credit, debit, or an exact transaction type.; pattern `^[a-z_]{1,40}$` |
| `status` | `completed` | `pending` | `failed` | `cancelled` |  |  |
| `currency` | string |  | pattern `^[A-Za-z]{3}$` |
| `reference_type` | string |  | Spend source, e.g. cdr or did_rental.; pattern `^[a-z_]{1,40}$` |
| `description` | string |  | Case-insensitive substring of the description. |
| `reference` | string |  | Case-insensitive substring of the reference. |
| `transaction_id` | string |  | Fetch one ledger entry by its ID.; pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| `page` | integer |  | min 1; max 100000 |
| `per_page` | integer |  | Max 1000.; min 1; max 1000 |

## list_transaction_types

List the reference_type values present on this Vobiz account's ledger (for example cdr, did_rental, recording), for use as the list_transactions reference_type filter. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|

## delete_recording

Permanently delete one call recording from this Vobiz account (DELETE /Recording/{id}/). The audio file cannot be restored afterwards. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `recording_id` | string | yes | pattern `^[A-Za-z0-9_-]{4,64}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: permanently deleting this recording. |

## release_phone_number

Release a phone number from this Vobiz account (DELETE /numbers/{e164}). This charges the account's number-release fee (returned as release_fee) and the number stops serving calls. By default it enters pending_release for a 24-hour cooldown, during which cancel_number_release restores it and refunds the fee; after that window the number leaves the account and may not be recoverable. immediate: true skips the cooldown and cannot be cancelled. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | pattern `^\+?[1-9]\d{6,14}$` |
| `immediate` | boolean |  | Skip the 24-hour cancellable cooldown. The release then cannot be cancelled. |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: releasing this number and paying the release fee. |

## cancel_number_release

Keep a number that is in pending_release (POST /account/{id}/numbers/{e164}/cancel-release): Vobiz restores it to active and refunds the release fee to the balance. Works only during the 24-hour cooldown. Any trunk or application the release detached must be re-linked with update_phone_number. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | pattern `^\+?[1-9]\d{6,14}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: cancelling the release of this number. |

## assign_number_to_subaccount

Move a number from this Vobiz account's pool to one of its sub-accounts (POST /account/{id}/numbers/{e164}/assign-subaccount). The sub-account then uses the number for its calls. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | pattern `^\+?[1-9]\d{6,14}$` |
| `sub_account_id` | string | yes | pattern `^SA_[A-Za-z0-9]{4,40}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: assigning this number to this sub-account. |

## unassign_number_from_subaccount

Move a number from a sub-account back to this Vobiz account's pool (DELETE /account/{id}/numbers/{e164}/assign-subaccount). A 15-day cool-off applies: a number with a call in the last 15 days is moved only after the cool-off ends. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `phone_number` | string | yes | pattern `^\+?[1-9]\d{6,14}$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: returning this number to the parent account pool. |

## list_sub_accounts

List the sub-accounts under this Vobiz main account: name, Auth ID (SA_...), status, KYC mode, rate limit and permissions. Credentials are redacted. Pagination is stateless: pass page/per_page (or limit/offset) on every call. Nothing is saved between calls. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `page` | integer |  | min 1; max 10000 |
| `size` | integer |  | Results per page, max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20).; min 1; max 100 |
| `active_only` | boolean |  | true returns only active sub-accounts. |

## get_sub_account

Return one Vobiz sub-account's details: name, contact, status, KYC mode, rate limit, permissions and timestamps. Credentials are redacted. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `sub_auth_id` | string | yes | The sub-account's Auth ID (SA_...), from list_sub_accounts.; pattern `^SA_[A-Za-z0-9]+$` |

## create_sub_account

Create a Vobiz sub-account under this main account (only name is required). kyc_mode customer_use needs email, and the new sub-account places calls only after its own KYC (see create_sub_account_kyc_session). The new sub-account's credentials are not returned here; the user copies them from the Vobiz console. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Human-readable name for the sub-account. |
| `email` | string |  | Contact email. Required for kyc_mode customer_use.; pattern `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |
| `phone` | string |  | pattern `^\+?[0-9 ()-]{6,20}$` |
| `description` | string |  |  |
| `rate_limit` | integer |  | API rate limit for the sub-account (Vobiz default 1000).; min 1; max 1000000 |
| `permissions` | object |  | Access flags. Omitted on create: the sub-account inherits the parent's default access. |
| `enabled` | boolean |  | Whether the sub-account can be used (default true). |
| `kyc_mode` | `personal_use` | `customer_use` |  | personal_use (default) uses the parent's KYC; customer_use means the sub-account completes its own KYC before placing calls (needs email). |
| `business_type` | `individual` | `proprietorship` | `private_limited` | `llp` | `partnership` | `public_limited` | `trust` | `society` | `huf` | `government` |  | Legal constitution of the customer; decides which KYC documents are collected. |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: creating this sub-account. |

## update_sub_account

Change a Vobiz sub-account's name, contact details, rate limit, permissions, enabled flag or kyc_mode. Only the fields you pass change. Moving to customer_use needs an email on the sub-account and can pause its calls until its KYC is verified. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `sub_auth_id` | string | yes | The sub-account's Auth ID (SA_...), from list_sub_accounts.; pattern `^SA_[A-Za-z0-9]+$` |
| `name` | string |  | Human-readable name for the sub-account. |
| `email` | string |  | Contact email. Required for kyc_mode customer_use.; pattern `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |
| `phone` | string |  | pattern `^\+?[0-9 ()-]{6,20}$` |
| `description` | string |  |  |
| `rate_limit` | integer |  | API rate limit for the sub-account (Vobiz default 1000).; min 1; max 1000000 |
| `permissions` | object |  | Access flags. Omitted on create: the sub-account inherits the parent's default access. |
| `enabled` | boolean |  | Whether the sub-account can be used (default true). |
| `kyc_mode` | `personal_use` | `customer_use` |  | personal_use (default) uses the parent's KYC; customer_use means the sub-account completes its own KYC before placing calls (needs email). |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: changing this sub-account. |

## delete_sub_account

Permanently delete a Vobiz sub-account and revoke its credentials. This removes the sub-account and cannot be undone: anything using its Auth ID stops working. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `sub_auth_id` | string | yes | The sub-account's Auth ID (SA_...), from list_sub_accounts.; pattern `^SA_[A-Za-z0-9]+$` |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: permanently deleting this sub-account and revoking its credentials. |

## get_sub_account_kyc_status

Return a Vobiz sub-account's aggregated KYC state: overall status, per-document status (PAN, GST, CIN, Aadhaar), business type and whether calls are paused pending KYC. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `sub_auth_id` | string | yes | The sub-account's Auth ID (SA_...), from list_sub_accounts.; pattern `^SA_[A-Za-z0-9]+$` |

## create_sub_account_kyc_session

Start a Vobiz-hosted KYC session for a sub-account. flow_type email (default) has Vobiz email the customer a secure verification link (customer_email required); flow_type redirect returns a widget_url to send the customer to (redirect_url required). Optional webhook_url receives KYC events. Track progress with get_sub_account_kyc_status. Gated by VOBIZ_ENABLE_PROVISIONING and confirm: true.

| Input | Type | Required | Notes |
|---|---|---|---|
| `sub_auth_id` | string | yes | The sub-account's Auth ID (SA_...), from list_sub_accounts.; pattern `^SA_[A-Za-z0-9]+$` |
| `flow_type` | `email` | `redirect` |  | Default email. |
| `customer_email` | string |  | Required for flow_type email: Vobiz sends the KYC link here.; pattern `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |
| `redirect_url` | string |  | Required for flow_type redirect: where the customer's browser goes after verification (public https). |
| `webhook_url` | string |  | Public https endpoint that receives KYC events. Omit for no callbacks. |
| `expires_in_days` | integer |  | Days until the link expires (Vobiz default 7).; min 1; max 90 |
| `confirm` | boolean | yes | Must be true, set only after the user explicitly approved: starting KYC for this sub-account (the email flow emails the customer). |

## schedule_reminder_call

Vobiz: use this when the user wants a PHONE CALL at a time — a wake-up call, a reminder call, 'call me at…'. Not for text or in-app reminders. The server places the call itself at that time, speaks the message, and lets the user press 1 to snooze, 2 to confirm, 9 to stop; it retries when there is no answer. Confirm the time (in the user's timezone), the message and the number with the user, then pass confirm: true. Call it ONCE per reminder: nothing has to stay open or be polled afterwards. `at` is ISO 8601 with an offset (2026-10-21T06:00:00+05:30), a local time without an offset (read in the timezone chosen at sign-in), or "now". `to` defaults to the user's own number from sign-in; `from` defaults to the caller ID chosen at sign-in, else the first voice number on the account. At most 30 days ahead.

| Input | Type | Required | Notes |
|---|---|---|---|
| `at` | string | yes | When to call: ISO 8601 with offset, local ISO time without offset (sign-in timezone), or "now". |
| `message` | string | yes | What the call says after the intro, in plain words (max 400 characters). |
| `kind` | `wake_up` | `reminder` |  | wake_up opens with a good-morning greeting; reminder (default) with a reminder greeting. |
| `to` | string |  | Number to call, E.164. One number only. Defaults to the user's own number from sign-in.; pattern `^\+?[1-9]\d{6,14}$` |
| `from` | string |  | Caller ID: a voice number on this account, E.164.; pattern `^\+?[1-9]\d{6,14}$` |
| `language` | `da-DK` | `nl-NL` | `en-AU` | `en-GB` | `en-US` | `en-IN` | `fr-FR` | `fr-CA` | `de-DE` | `it-IT` | `pl-PL` | `pt-PT` | `pt-BR` | `ru-RU` | `es-ES` | `es-US` | `sv-SE` | `hi-IN` |  | Speech language (default en-US). |
| `voice` | `WOMAN` | `MAN` |  | Speech voice (default WOMAN). |
| `snooze_minutes` | integer |  | Pressing 1 calls again after this many minutes (default 10).; min 1; max 60 |
| `max_attempts` | integer |  | Total call attempts including retries (default 3).; min 1; max 5 |
| `retry_minutes` | integer |  | Minutes between retries after no answer, busy or voicemail (default 5).; min 1; max 30 |
| `confirm` | boolean | yes | Must be true, set only after the user confirmed the time, message and number. |
| `idempotency_key` | string |  | Unique key for this intended operation (e.g. a UUID). Repeating it replays the first result instead of acting again.; pattern `^[A-Za-z0-9_.:-]{8,128}$` |

## list_reminder_calls

List the reminder and wake-up calls scheduled on this Vobiz account, newest first, with their status and next call time in the user's timezone. Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `status` | `scheduled` | `calling` | `snoozed` | `done` | `stopped` | `cancelled` | `failed` | `active` |  | Filter by status; active = scheduled, snoozed or calling. |
| `limit` | integer |  | Max reminders to return (default 20).; min 1; max 50 |

## get_reminder_call

Return ONE reminder call with every attempt so far and what happened on each (answered and confirmed, snoozed, not answered, busy, voicemail…). Read-only.

| Input | Type | Required | Notes |
|---|---|---|---|
| `reminder_id` | string | yes | pattern `^[A-Za-z0-9_-]{4,100}$` |

## cancel_reminder_call

Cancel ONE scheduled or snoozed reminder call so no further calls are placed for it. Needs confirm: true after the user agrees. Cancelling an already finished reminder changes nothing.

| Input | Type | Required | Notes |
|---|---|---|---|
| `reminder_id` | string | yes | pattern `^[A-Za-z0-9_-]{4,100}$` |
| `confirm` | boolean | yes | Must be true, set only after the user confirmed cancelling this reminder. |

## list_vobiz_skills

List the Vobiz Agent Skills bundled with this server: expert playbooks for each Vobiz product (voice calls, VobizXML, SIP trunking, phone numbers, CDRs, audio streams, AI voice agents, SMS/MMS/RCS, WhatsApp, sub-accounts, Partner API, Plivo migration, solution scoping). Each one can be loaded with get_vobiz_skill when planning a multi-step task or writing integration code. Read-only, no API call.

| Input | Type | Required | Notes |
|---|---|---|---|

## get_vobiz_skill

Return the instructions of one Vobiz Agent Skill (endpoints, request shapes, VobizXML rules, pitfalls). Pass `section` to load only one `##` section (names come from list_vobiz_skills). Read-only, no API call.

| Input | Type | Required | Notes |
|---|---|---|---|
| `name` | `vobiz-ai-voice-agents` | `vobiz-api` | `vobiz-applications-endpoints` | `vobiz-audio-streams` | `vobiz-cdr` | `vobiz-forward-deployed-engineer` | `vobiz-partner-api` | `vobiz-phone-numbers` | `vobiz-plivo-migration` | `vobiz-sip-trunking` | `vobiz-sms` | `vobiz-sub-accounts` | `vobiz-voice-calls` | `vobiz-voice-xml` | `vobiz-whatsapp` | yes | Skill name from list_vobiz_skills, e.g. vobiz-voice-calls. |
| `section` | string |  | Optional `##` heading to return instead of the whole skill (case-insensitive prefix match). |
