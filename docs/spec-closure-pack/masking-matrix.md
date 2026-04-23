# Masking Matrix v1

## Vendor Manager
- consented vendor release: full name, company, contact fields if event policy permits
- declined or missing vendor consent: masked personal fields, anonymous interaction retained

## Sponsor User
- default: aggregate-only metrics
- raw lead visibility requires:
  - sponsor release consent
  - event `sponsor_pii_enabled = true`
  - sponsor export or view feature enabled by organizer policy

## Organizer Admin
- event-scoped operational visibility
- export and trust workflows visible
- direct PII display still constrained by effective consent and purpose

## Platform Admin
- masked by default
- privileged access only under active break-glass session

## Ops User
- no attendee PII
- device and incident data only
