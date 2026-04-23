# Pilot Go-Live Checklist

## Release Control
- Approved release manifest is present and points to the intended staging and production build versions
- Staging and production parity check passes
- Last staging certification is current

## Operational Health
- Latest integration orchestration run completed successfully
- IoT health check is fresh
- No open critical IoT alerts remain
- Device fleet shows no unresolved assignment mismatches for active pilot devices

## Manual Validation
- Organizer reviewed `GET /organizer/events/:eventId/iot-go-live-readiness`
- Organizer reviewed `GET /organizer/events/:eventId/iot-health`
- Organizer reviewed `GET /organizer/events/:eventId/iot-alerts`
- Joint go-live commander signed off

## Escalation Readiness
- staging alert webhook destinations are configured
- production/parity alert webhook destinations are configured
- rollback owner and joint incident owners are reachable
