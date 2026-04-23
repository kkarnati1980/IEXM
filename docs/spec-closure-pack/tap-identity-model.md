# Tap Identity Model

Canonical tap classes for pilot:

## `phone_ndef`
- source: NDEF-capable phone tap
- may create attendee session bootstrap or optional profile hints
- must not be treated as authoritative identity unless attendee confirms or later consents

## `card_uid`
- source: NFC card or tag UID
- creates anonymous interaction only
- can become linked to an attendee later through attendee-controlled action

## `qr`
- source: QR session entry
- no NFC requirement
- creates session-bound interaction context

## Locked Rules
- no name or company may be assumed at tap time unless explicitly attendee-provided
- identity is interaction-first and profile-later
- consent controls release of personal data, not the existence of the interaction record
