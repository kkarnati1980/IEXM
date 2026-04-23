# Kiosk State Machine v1

States:
- `BOOTING`
- `CONFIG_LOADING`
- `CONFIG_ERROR`
- `LOCKED_UNASSIGNED`
- `IDLE`
- `OFFLINE_IDLE`
- `TAP_READING`
- `INTERACTION_ACTIVE`
- `INTERACTION_EXCEPTION`
- `SYNCING_BACKGROUND`
- `READER_ERROR`
- `DIAGNOSTICS`

Locked rules:
- a tap is not valid until durably written to local queue
- queue order is ascending `queue_sequence_number`
- active screen resets after 15 seconds by default
- duplicate replay from sync is success, not error
- QR fallback is always available unless explicitly disabled by kiosk fault state
