# IoT Error Catalog

Status: Frozen  
Contract version: `2026-04-17.1`

## Error Envelope
Every non-2xx response must use:

```json
{
  "contract_version": "2026-04-17.1",
  "environment": "staging",
  "build_version": "iot-2026.04.17.3",
  "error": {
    "code": "ASSIGNMENT_SCOPE_VIOLATION",
    "message": "Assignment checksum does not match active assignment",
    "retryable": false,
    "details": {
      "device_id": "device-01",
      "expected_assignment_checksum": "abc123",
      "received_assignment_checksum": "def456"
    }
  }
}
```

## Catalog
| HTTP | Code | Retryable | Meaning |
| --- | --- | --- | --- |
| 400 | `VALIDATION_FAILED` | false | Body, query, or path fields do not match contract. |
| 400 | `CURSOR_INVALID` | false | `after_cursor` is malformed or unknown. |
| 401 | `AUTH_INVALID_CREDENTIAL` | false | Caller token is missing, malformed, or unauthorized. |
| 401 | `AUTH_CREDENTIAL_REVOKED` | false | Device or service credential has been revoked. |
| 403 | `ENVIRONMENT_ACCESS_DENIED` | false | Caller is not allowed to access this environment. |
| 404 | `DEVICE_NOT_FOUND` | false | Device does not exist in the IoT platform. |
| 404 | `ASSIGNMENT_NOT_FOUND` | false | Device has no active assignment. |
| 404 | `CREDENTIAL_NOT_FOUND` | false | Credential id does not exist. |
| 409 | `ASSIGNMENT_SCOPE_VIOLATION` | false | Device is acting with the wrong event, stall, or checksum. |
| 409 | `LEASE_EXPIRED` | false | Assignment or config lease has expired. |
| 409 | `CURSOR_EXPIRED` | true | Cursor aged out; consumer must restart from checkpoint policy. |
| 409 | `UNSUPPORTED_CONTRACT_VERSION` | false | Staging/production build does not implement the requested contract version. |
| 429 | `RATE_LIMITED` | true | Consumer exceeded allowed request rate. |
| 500 | `INTERNAL_ERROR` | true | Unclassified server-side failure. |
| 503 | `DOWNSTREAM_UNAVAILABLE` | true | IoT service or persistence dependency is unavailable. |

## Normative Rules
- `message` may be human-readable, but `code` is authoritative.
- `retryable` must reflect actual behavior expected from the consumer.
- New error codes may not be introduced without contract version change.
- Duplicate tap replay is not an error. It must appear as a normal stream record and remain deduplicable by `(device_id, local_event_id)`.

