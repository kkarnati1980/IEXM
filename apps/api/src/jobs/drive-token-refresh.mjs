import { refreshGoogleToken } from '../drive/google-oauth.mjs'
import { refreshOneDriveToken } from '../drive/onedrive-oauth.mjs'
import { encryptToken } from '../drive/encryption.mjs'

export async function runDriveTokenRefreshOnce(repos) {
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000)
  let connections
  try {
    connections = await repos.stallDriveConnections.findExpiringBefore(soon)
  } catch (err) {
    console.error('[drive-refresh] Failed to list expiring connections:', err.message)
    return
  }

  for (const conn of connections) {
    try {
      let newTokens
      if (conn.provider === 'google_drive') {
        newTokens = await refreshGoogleToken(conn.refresh_token)
      } else {
        newTokens = await refreshOneDriveToken(conn.refresh_token)
      }

      if (!newTokens?.access_token) {
        throw new Error('Provider returned no access_token')
      }

      await repos.stallDriveConnections.updateTokens(conn.id, {
        access_token: encryptToken(newTokens.access_token),
        token_expires_at: new Date(Date.now() + (newTokens.expires_in ?? 3600) * 1000).toISOString(),
        last_refreshed_at: new Date().toISOString()
      })
      console.log(`[drive-refresh] Refreshed token for connection ${conn.id}`)
    } catch (err) {
      console.error(`[drive-refresh] Failed to refresh ${conn.id}:`, err.message)
      try {
        await repos.stallDriveConnections.setStatus(conn.id, 'error')
      } catch (setErr) {
        console.error(`[drive-refresh] Could not set error status for ${conn.id}:`, setErr.message)
      }
    }
  }
}

export function startDriveTokenRefreshJob(repos) {
  const intervalMs = 60 * 60 * 1000 // hourly
  const timer = setInterval(() => runDriveTokenRefreshOnce(repos), intervalMs)
  timer.unref?.()
  console.log('[drive-refresh] Token refresh job started (hourly)')
}
