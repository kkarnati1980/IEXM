# Offline Auth and Device Credential Model

## User Authentication
- users authenticate with OIDC in connected mode
- access tokens are short-lived JWTs
- refresh tokens rotate server-side

## Device Authentication
- every device has a provisioned credential pair
- every config response includes a signed config lease
- device actions are scoped to current assignment and lease validity

## Offline Rules
- kiosk may continue local capture using last valid config while lease is valid
- expired lease blocks privileged remote actions and fresh config fetch
- expired lease does not block local queue capture

## Operational Controls
- lost device revocation invalidates future config fetches and privileged actions
- reprovisioning requires new device credential issuance and assignment confirmation
