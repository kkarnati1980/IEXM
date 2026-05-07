import test from 'node:test'
import assert from 'node:assert/strict'

// Test encryption key: 32 bytes = 64 hex chars
process.env.DRIVE_ENCRYPTION_KEY = 'a'.repeat(64)
process.env.DRIVE_ACCESS_TOKEN_EXPIRY_DAYS = '30'
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret'
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/auth/drive/google/callback'
process.env.ONEDRIVE_CLIENT_ID = 'od-client-id'
process.env.ONEDRIVE_CLIENT_SECRET = 'od-secret'
process.env.ONEDRIVE_REDIRECT_URI = 'http://localhost:3000/auth/drive/onedrive/callback'
process.env.ONEDRIVE_TENANT_ID = 'common'
process.env.SESSION_SECRET = 'test-session-secret-for-drive-tests'
process.env.BASE_URL = 'http://localhost:3000'

import { encryptToken, decryptToken } from '../src/drive/encryption.mjs'
import { getGoogleAuthUrl } from '../src/drive/google-oauth.mjs'
import { getOneDriveAuthUrl } from '../src/drive/onedrive-oauth.mjs'
import { createApp } from '../src/app.mjs'
import { createSeedState } from '../src/store.mjs'
import { issuePlatformToken } from '../src/auth/platform-jwt.mjs'
import { buildUserPrincipal } from '../src/auth/principals.mjs'

// ── Helpers ──────────────────────────────────────────────────────

function bearer(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

function jwtFor(state, userId) {
  const user = state.users.find(u => u.id === userId)
  if (!user) throw new Error(`User ${userId} not found in seed state. Users: ${state.users.map(u => u.id).join(', ')}`)
  const assignments = (state.userRoleAssignments ?? []).filter(a => a.user_id === user.id)
  const scopes = (state.userAccessScopes ?? []).filter(s => s.user_id === user.id)
  const principal = buildUserPrincipal(user, scopes, assignments)
  return issuePlatformToken(principal, state.sessionSecret)
}

function vendorJwt(state) {
  // Find any vendor_manager user
  const vendorUser = state.users.find(u => {
    const assignments = (state.userRoleAssignments ?? []).filter(a => a.user_id === u.id)
    return assignments.some(a => a.role === 'vendor_manager')
  })
  if (!vendorUser) throw new Error('No vendor_manager user in seed state')
  return jwtFor(state, vendorUser.id)
}
function platformJwt(state) { return jwtFor(state, 'user-platform-1') }

function getStallId(state) {
  return state.stalls?.[0]?.id ?? 'stall-ie-a1'
}
function getTenantId(state) {
  return state.tenants?.[0]?.id ?? 'tenant-demo'
}
function getEventId(state) {
  return state.stalls?.[0]?.event_id ?? 'event-indiaexpo'
}

async function makeApp() {
  const state = createSeedState()
  const app = await createApp({ state, backend: 'memory', enableJobs: false })
  return { app, state }
}

// ── Test 1: encryptToken / decryptToken roundtrip ─────────────────

test('encryptToken / decryptToken roundtrip', () => {
  const plaintext = 'ya29.some-google-access-token'
  const ciphertext = encryptToken(plaintext)
  assert.ok(ciphertext, 'should produce ciphertext')
  assert.notEqual(ciphertext, plaintext)
  assert.equal(decryptToken(ciphertext), plaintext)
})

test('encryptToken returns null for null/empty input', () => {
  assert.equal(encryptToken(null), null)
  assert.equal(encryptToken(''), null)
})

test('decryptToken returns null for null input', () => {
  assert.equal(decryptToken(null), null)
})

// ── Test 2: Google auth URL contains expected params ──────────────

test('getGoogleAuthUrl returns valid OAuth URL', () => {
  const url = getGoogleAuthUrl({ stallId: 's1', eventId: 'e1', tenantId: 't1', userId: 'u1', provider: 'google_drive' })
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'))
  assert.ok(url.includes('client_id=test-client-id'))
  assert.ok(url.includes('access_type=offline'))
  assert.ok(url.includes('state='))
})

test('getOneDriveAuthUrl returns valid OAuth URL', () => {
  const url = getOneDriveAuthUrl({ stallId: 's1', eventId: 'e1', tenantId: 't1', userId: 'u1', provider: 'onedrive' })
  assert.ok(url.includes('login.microsoftonline.com'))
  assert.ok(url.includes('client_id=od-client-id'))
  assert.ok(url.includes('state='))
})

// ── Test 3: GET connection status — not connected ─────────────────

test('GET /stalls/:id/drive/connection returns not-connected by default', async () => {
  const { app, state } = await makeApp()
  const token = vendorJwt(state)
  const stallId = state.userRoleAssignments.find(a => a.role === 'vendor_manager')?.metadata?.stall_ids?.[0]
    ?? state.stalls?.[0]?.id
    ?? 'stall-ie-a1'

  const res = await app.inject({
    method: 'GET',
    path: `/stalls/${stallId}/drive/connection`,
    headers: bearer(token)
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.connected, false)
})

// ── Test 4: POST shared folder — no connection → 409 ─────────────

test('POST shared folder without active connection returns 409', async () => {
  const { app, state } = await makeApp()
  const token = vendorJwt(state)
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'

  const res = await app.inject({
    method: 'POST',
    path: `/stalls/${stallId}/drive/shared-folders`,
    headers: bearer(token),
    body: { folder_id: 'folder-123', folder_name: 'Brochures' }
  })
  assert.equal(res.statusCode, 409)
})

// ── Test 5: Create connection then shared folder ──────────────────

test('Create connection + shared folder + list folders', async () => {
  const { app, state } = await makeApp()
  const token = vendorJwt(state)
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'
  const tenantId = state.tenants?.[0]?.id ?? 'tenant-demo'

  // Manually create connection in memory repo
  await app.repos.stallDriveConnections.create({
    id: 'sdc-test1',
    tenant_id: tenantId,
    stall_id: stallId,
    event_id: state.stalls?.[0]?.event_id ?? 'event-indiaexpo',
    provider: 'google_drive',
    connected_by_user_id: 'user-vendor-1',
    access_token: encryptToken('test-access-token'),
    refresh_token: null,
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    drive_account_email: 'vendor@example.com',
    status: 'active',
    connected_at: new Date().toISOString()
  })

  // Create shared folder
  const createRes = await app.inject({
    method: 'POST',
    path: `/stalls/${stallId}/drive/shared-folders`,
    headers: bearer(token),
    body: { folder_id: 'gdrive-folder-abc', folder_name: 'Product Brochures', default_access: 'open', allow_view: true, allow_download: true }
  })
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body))
  assert.equal(createRes.body.folder_name, 'Product Brochures')
  assert.equal(createRes.body.default_access, 'open')

  // List folders
  const listRes = await app.inject({
    method: 'GET',
    path: `/stalls/${stallId}/drive/shared-folders`,
    headers: bearer(token)
  })
  assert.equal(listRes.statusCode, 200)
  assert.equal(listRes.body.items.length, 1)
  assert.equal(listRes.body.items[0].folder_name, 'Product Brochures')
})

// ── Test 6: PATCH shared folder updates allow_download ────────────

test('PATCH shared folder updates allow_download', async () => {
  const { app, state } = await makeApp()
  const token = vendorJwt(state)
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'
  const tenantId = state.tenants?.[0]?.id ?? 'tenant-demo'
  const eventId = state.stalls?.[0]?.event_id ?? 'event-indiaexpo'

  await app.repos.stallDriveConnections.create({
    id: 'sdc-patch-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    provider: 'google_drive', connected_by_user_id: 'user-vendor-1',
    access_token: encryptToken('tok'), refresh_token: null,
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    drive_account_email: 'vendor@example.com', status: 'active',
    connected_at: new Date().toISOString()
  })
  const folder = await app.repos.stallSharedFolders.create({
    id: 'ssf-patch-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    connection_id: 'sdc-patch-test', provider: 'google_drive',
    folder_id: 'gf-1', folder_name: 'Specs', folder_path: null,
    default_access: 'open', allow_download: true, allow_view: true,
    status: 'active', sort_order: 0, created_at: new Date().toISOString()
  })

  const patchRes = await app.inject({
    method: 'PATCH',
    path: `/stalls/${stallId}/drive/shared-folders/${folder.id}`,
    headers: bearer(token),
    body: { allow_download: false }
  })
  assert.equal(patchRes.statusCode, 200)
  assert.equal(patchRes.body.allow_download, false)
})

// ── Test 7: Access grant docs endpoint — invalid token → 404 ─────

test('GET /docs/:token/folders with invalid token returns 404', async () => {
  const { app } = await makeApp()
  const res = await app.inject({
    method: 'GET',
    path: '/docs/nonexistent-token-abc123/folders'
  })
  assert.equal(res.statusCode, 404)
})

// ── Test 8: Access grant — revoked → 410 ─────────────────────────

test('GET /docs/:token/folders with revoked grant returns 410', async () => {
  const { app, state } = await makeApp()
  const tenantId = state.tenants?.[0]?.id ?? 'tenant-demo'
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'
  const eventId = state.stalls?.[0]?.event_id ?? 'event-indiaexpo'

  await app.repos.stallSharedFolders.create({
    id: 'ssf-revoke-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    connection_id: 'sdc-x', provider: 'google_drive',
    folder_id: 'gf-r', folder_name: 'Specs', folder_path: null,
    default_access: 'open', allow_download: true, allow_view: true,
    status: 'active', sort_order: 0, created_at: new Date().toISOString()
  })
  await app.repos.stallFolderAccess.create({
    id: 'sfa-revoke-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    folder_id: 'ssf-revoke-test', attendee_id: null, interaction_id: null,
    access_token: 'revoked-access-token-xyz',
    access_token_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    granted_by: 'manual', status: 'revoked', access_count: 0,
    granted_at: new Date().toISOString()
  })

  const res = await app.inject({ method: 'GET', path: '/docs/revoked-access-token-xyz/folders' })
  assert.equal(res.statusCode, 410)
})

// ── Test 9: Access grant — suspended → 403 ───────────────────────

test('GET /docs/:token/folders with suspended grant returns 403', async () => {
  const { app, state } = await makeApp()
  const tenantId = state.tenants?.[0]?.id ?? 'tenant-demo'
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'
  const eventId = state.stalls?.[0]?.event_id ?? 'event-indiaexpo'

  await app.repos.stallSharedFolders.create({
    id: 'ssf-suspend-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    connection_id: 'sdc-x', provider: 'google_drive',
    folder_id: 'gf-s', folder_name: 'Specs', folder_path: null,
    default_access: 'open', allow_download: true, allow_view: true,
    status: 'active', sort_order: 0, created_at: new Date().toISOString()
  })
  await app.repos.stallFolderAccess.create({
    id: 'sfa-suspend-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    folder_id: 'ssf-suspend-test', attendee_id: null, interaction_id: null,
    access_token: 'suspended-token-abc',
    access_token_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    granted_by: 'manual', status: 'suspended', access_count: 0,
    granted_at: new Date().toISOString()
  })

  const res = await app.inject({ method: 'GET', path: '/docs/suspended-token-abc/folders' })
  assert.equal(res.statusCode, 403)
})

// ── Test 10: Access grant — expired → 410 ────────────────────────

test('GET /docs/:token/folders with expired grant returns 410', async () => {
  const { app, state } = await makeApp()
  const tenantId = state.tenants?.[0]?.id ?? 'tenant-demo'
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'
  const eventId = state.stalls?.[0]?.event_id ?? 'event-indiaexpo'

  await app.repos.stallSharedFolders.create({
    id: 'ssf-expire-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    connection_id: 'sdc-x', provider: 'google_drive',
    folder_id: 'gf-e', folder_name: 'Specs', folder_path: null,
    default_access: 'open', allow_download: true, allow_view: true,
    status: 'active', sort_order: 0, created_at: new Date().toISOString()
  })
  await app.repos.stallFolderAccess.create({
    id: 'sfa-expire-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    folder_id: 'ssf-expire-test', attendee_id: null, interaction_id: null,
    access_token: 'expired-token-abc',
    access_token_expires_at: new Date(Date.now() - 1000).toISOString(), // already past
    granted_by: 'manual', status: 'active', access_count: 0,
    granted_at: new Date().toISOString()
  })

  const res = await app.inject({ method: 'GET', path: '/docs/expired-token-abc/folders' })
  assert.equal(res.statusCode, 410)
})

// ── Test 11: Revoke grant via API ─────────────────────────────────

test('POST /revoke sets grant status to revoked', async () => {
  const { app, state } = await makeApp()
  const token = vendorJwt(state)
  const tenantId = state.tenants?.[0]?.id ?? 'tenant-demo'
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'
  const eventId = state.stalls?.[0]?.event_id ?? 'event-indiaexpo'

  await app.repos.stallSharedFolders.create({
    id: 'ssf-api-revoke',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    connection_id: 'sdc-x', provider: 'google_drive',
    folder_id: 'gf-rv', folder_name: 'Brochures',
    default_access: 'open', allow_download: true, allow_view: true,
    status: 'active', sort_order: 0, created_at: new Date().toISOString()
  })
  await app.repos.stallFolderAccess.create({
    id: 'sfa-api-revoke',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    folder_id: 'ssf-api-revoke', attendee_id: null, interaction_id: null,
    access_token: 'active-token-to-revoke',
    access_token_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    granted_by: 'manual', status: 'active', access_count: 0,
    granted_at: new Date().toISOString()
  })

  const res = await app.inject({
    method: 'POST',
    path: `/stalls/${stallId}/drive/access-grants/sfa-api-revoke/revoke`,
    headers: bearer(token),
    body: { reason: 'Test revoke' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.revoked, true)
  assert.equal(res.body.grant.status, 'revoked')
})

// ── Test 12: Suspend then restore ────────────────────────────────

test('Suspend and restore a grant', async () => {
  const { app, state } = await makeApp()
  const token = vendorJwt(state)
  const tenantId = state.tenants?.[0]?.id ?? 'tenant-demo'
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'
  const eventId = state.stalls?.[0]?.event_id ?? 'event-indiaexpo'

  await app.repos.stallSharedFolders.create({
    id: 'ssf-sus-rest',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    connection_id: 'sdc-x', provider: 'google_drive',
    folder_id: 'gf-sr', folder_name: 'Specs',
    default_access: 'open', allow_download: true, allow_view: true,
    status: 'active', sort_order: 0, created_at: new Date().toISOString()
  })
  await app.repos.stallFolderAccess.create({
    id: 'sfa-sus-rest',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    folder_id: 'ssf-sus-rest', attendee_id: null, interaction_id: null,
    access_token: 'tok-suspend-restore',
    access_token_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    granted_by: 'manual', status: 'active', access_count: 0,
    granted_at: new Date().toISOString()
  })

  const suspendRes = await app.inject({
    method: 'POST',
    path: `/stalls/${stallId}/drive/access-grants/sfa-sus-rest/suspend`,
    headers: bearer(token), body: {}
  })
  assert.equal(suspendRes.statusCode, 200)
  assert.equal(suspendRes.body.grant.status, 'suspended')

  const restoreRes = await app.inject({
    method: 'POST',
    path: `/stalls/${stallId}/drive/access-grants/sfa-sus-rest/restore`,
    headers: bearer(token), body: {}
  })
  assert.equal(restoreRes.statusCode, 200)
  assert.equal(restoreRes.body.grant.status, 'active')
})

// ── Test 13: Archive shared folder ───────────────────────────────

test('DELETE shared folder archives it', async () => {
  const { app, state } = await makeApp()
  const token = vendorJwt(state)
  const tenantId = state.tenants?.[0]?.id ?? 'tenant-demo'
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'
  const eventId = state.stalls?.[0]?.event_id ?? 'event-indiaexpo'

  await app.repos.stallDriveConnections.create({
    id: 'sdc-arch-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    provider: 'google_drive', connected_by_user_id: 'user-vendor-1',
    access_token: encryptToken('tok'), refresh_token: null,
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    drive_account_email: 'v@ex.com', status: 'active',
    connected_at: new Date().toISOString()
  })
  const folder = await app.repos.stallSharedFolders.create({
    id: 'ssf-arch-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    connection_id: 'sdc-arch-test', provider: 'google_drive',
    folder_id: 'gf-a', folder_name: 'To Archive',
    default_access: 'open', allow_download: true, allow_view: true,
    status: 'active', sort_order: 0, created_at: new Date().toISOString()
  })

  const res = await app.inject({
    method: 'DELETE',
    path: `/stalls/${stallId}/drive/shared-folders/${folder.id}`,
    headers: bearer(token), body: {}
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.archived, true)

  const listRes = await app.inject({
    method: 'GET',
    path: `/stalls/${stallId}/drive/shared-folders`,
    headers: bearer(token)
  })
  assert.equal(listRes.body.items.length, 0)
})

// ── Test 14: Access grants list ───────────────────────────────────

test('GET access grants returns list', async () => {
  const { app, state } = await makeApp()
  const token = vendorJwt(state)
  const tenantId = state.tenants?.[0]?.id ?? 'tenant-demo'
  const stallId = state.stalls?.[0]?.id ?? 'stall-ie-a1'
  const eventId = state.stalls?.[0]?.event_id ?? 'event-indiaexpo'

  await app.repos.stallSharedFolders.create({
    id: 'ssf-list-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    connection_id: 'sdc-x', provider: 'google_drive',
    folder_id: 'gf-l', folder_name: 'Brochures',
    default_access: 'open', allow_download: true, allow_view: true,
    status: 'active', sort_order: 0, created_at: new Date().toISOString()
  })
  await app.repos.stallFolderAccess.create({
    id: 'sfa-list-test',
    tenant_id: tenantId, stall_id: stallId, event_id: eventId,
    folder_id: 'ssf-list-test', attendee_id: null, interaction_id: null,
    access_token: 'list-tok-1',
    access_token_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    granted_by: 'auto', status: 'active', access_count: 2,
    granted_at: new Date().toISOString()
  })

  const res = await app.inject({
    method: 'GET',
    path: `/stalls/${stallId}/drive/access-grants`,
    headers: bearer(token)
  })
  assert.equal(res.statusCode, 200)
  assert.ok(res.body.items.length >= 1)
})

// ── Test 15: encryptToken different each call (random IV) ─────────

test('encryptToken produces different ciphertext each call', () => {
  const plaintext = 'same-token-value'
  const c1 = encryptToken(plaintext)
  const c2 = encryptToken(plaintext)
  assert.notEqual(c1, c2)
  assert.equal(decryptToken(c1), plaintext)
  assert.equal(decryptToken(c2), plaintext)
})
