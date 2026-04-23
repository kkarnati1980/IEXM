# Break-Glass SOP

## Mandatory Rules
- requester and approver must be different people
- second approval is required before activation
- fixed scope and expiry are mandatory
- no self-approval
- no standing privileged access
- every read and write under break-glass is auditable
- access auto-expires and is force-revoked at expiry

## Pilot Workflow
1. requester submits justification, scope, and expiry
2. first approver reviews and approves or rejects
3. second approver confirms
4. session becomes active for fixed duration
5. all covered actions are tagged with break-glass session id
6. session expires or is manually revoked
