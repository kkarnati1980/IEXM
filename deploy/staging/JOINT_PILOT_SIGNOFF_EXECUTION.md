# Joint Pilot Signoff Execution

Use this workflow when both teams are ready to run the real staging go-live dry run and capture the final cross-team approvals.

## Inputs required before starting

- real staging environment access is working
- IoT API contract/version is already certified
- `GET /organizer/events/:eventId/pilot-signoff-pack` is either ready or has only known blockers being exercised in the dry run
- named organizer, platform, and IoT owners are available for the session

## Execution flow

1. Run the real staging dry run using the agreed pilot go-live checklist.
2. Record the dry-run result:
   - `POST /organizer/events/:eventId/pilot-go-live-dry-run`
3. Refresh the joint execution view:
   - `GET /organizer/events/:eventId/pilot-go-live-execution`
4. Record the three approvals:
   - `POST /organizer/events/:eventId/pilot-go-live-approvals`
   - `approver_role=organizer`
   - `approver_role=platform`
   - `approver_role=iot`
5. Refresh the execution view again and confirm the remaining blockers list is empty.

## Minimum evidence to capture

- dry-run status
- whether all checklist items passed
- any blockers found during the run
- a short note summarizing environment, timing, and result
- approver label and note for organizer, platform, and IoT

## Final gate

The event is ready for final pilot signoff only when:

- `GET /organizer/events/:eventId/pilot-signoff-pack` is ready
- the latest `pilot-go-live-dry-run` record is `completed`
- the latest dry run says `all_checks_passed`
- organizer, platform, and IoT approvals are all `approved`

## If the dry run fails

- record the dry run as `failed`
- list blockers explicitly
- do not record approvals as `approved`
- reopen the pilot signoff review only after the blockers are resolved and a fresh dry run is completed
