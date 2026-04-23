# ADR-001: Kiosk Runtime Architecture

## Status
Accepted for pilot.

## Decision
Replace the ambiguous "pure locked PWA" reading with a layered runtime:
- Android kiosk host for device lock-down, USB/NFC lifecycle, watchdog relaunch, and health hooks
- web UI shell for kiosk presentation and attendee-facing screens
- native NFC bridge for ACR122U interaction, normalized tap emission, and diagnostics handoff

## Why
- ACR122U USB reader support is a hardware dependency that cannot be trusted to a browser-only runtime
- crash recovery and kiosk relaunch belong in the host layer
- this keeps presentation portable while moving hardware risk out of the browser

## Pilot Implications
- the web shell is the default UI implementation surface
- the Android host is an explicit required workstream before production
- QR fallback remains mandatory even if NFC is unavailable
