# Metric Versioning Policy

Pilot metric governance is versioned and immutable once frozen.

## Required fields
- `metrics_definition_version`
- `report_snapshot_version`

## Rules
- every pilot metric uses a documented formula version
- official post-event reports are stored as immutable snapshots
- late-arriving corrections create a new snapshot version
- official reports are never silently overwritten

## Pilot Metric Set
- sponsor: impressions, clicks, CTR, opted-in leads, top zones, hourly trend
- organizer: total interactions, online devices, offline devices, queue depth, sync latency, top stalls
- vendor: total taps, unique leads, hot leads, CRM eligible/pushed counts
