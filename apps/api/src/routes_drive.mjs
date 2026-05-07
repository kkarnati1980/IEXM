import { randomBytes } from 'node:crypto'
import { HttpError } from './http-error.mjs'
import { encryptToken, decryptToken } from './drive/encryption.mjs'
import {
  getGoogleAuthUrl,
  exchangeGoogleCode,
  getGoogleUserEmail,
  listGoogleFolders,
  listGoogleFiles,
  getGoogleViewerUrl
} from './drive/google-oauth.mjs'
import {
  getOneDriveAuthUrl,
  exchangeOneDriveCode,
  getOneDriveUserEmail,
  listOneDriveFolders,
  listOneDriveFiles,
  getOneDriveViewerUrl
} from './drive/onedrive-oauth.mjs'

function shortId() {
  return randomBytes(6).toString('hex')
}

function parseState(raw) {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

async function getDecryptedAccessToken(repos, connection) {
  if (!connection) throw new HttpError(404, 'No active drive connection for this stall')
  if (connection.status !== 'active') throw new HttpError(409, 'Drive connection is not active')
  return decryptToken(connection.access_token)
}

async function resolveStallAndConnection(repos, principal, stallId) {
  const stall = await repos.stalls.findById(principal.tenant_id, stallId)
  if (!stall) throw new HttpError(404, 'Stall not found')
  const connection = await repos.stallDriveConnections.findActive(stallId, principal.tenant_id)
  return { stall, connection }
}

export function registerDriveRoutes(router) {
  // ── OAuth Initiation ─────────────────────────────────────────────────────────

  router.addRoute({
    id: 'stall-drive-connect-google',
    method: 'GET',
    path: '/stalls/:stallId/drive/connect/google',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ resources, principal }) => {
      const state = {
        stallId: resources.stall.id,
        eventId: resources.stall.event_id,
        tenantId: principal.tenant_id,
        userId: principal.id,
        provider: 'google_drive'
      }
      return { auth_url: getGoogleAuthUrl(state) }
    }
  })

  router.addRoute({
    id: 'stall-drive-connect-onedrive',
    method: 'GET',
    path: '/stalls/:stallId/drive/connect/onedrive',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ resources, principal }) => {
      const state = {
        stallId: resources.stall.id,
        eventId: resources.stall.event_id,
        tenantId: principal.tenant_id,
        userId: principal.id,
        provider: 'onedrive'
      }
      return { auth_url: getOneDriveAuthUrl(state) }
    }
  })

  // ── OAuth Callbacks (public — browser redirect from provider) ─────────────────

  router.addRoute({
    id: 'drive-google-callback',
    method: 'GET',
    path: '/auth/drive/google/callback',
    authRequired: false,
    handler: async ({ repos, query }) => {
      const { code, state: rawState, error } = query
      if (error) return { _redirect: '/vendor?drive_error=' + encodeURIComponent(error) }
      if (!code || !rawState) return { _redirect: '/vendor?drive_error=missing_params' }

      const state = parseState(rawState)
      if (!state?.stallId || !state?.tenantId) {
        return { _redirect: '/vendor?drive_error=invalid_state' }
      }

      try {
        const tokens = await exchangeGoogleCode(code)
        if (!tokens.access_token) {
          return { _redirect: '/vendor?drive_error=token_exchange_failed' }
        }
        const email = await getGoogleUserEmail(tokens.access_token)
        const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000)

        // Deactivate any existing active connections for this stall
        const existing = await repos.stallDriveConnections.findByStall(state.stallId, state.tenantId)
        for (const conn of existing.filter(c => c.status === 'active')) {
          await repos.stallDriveConnections.setStatus(conn.id, 'disconnected')
        }

        await repos.stallDriveConnections.create({
          id: 'sdc-' + shortId(),
          tenant_id: state.tenantId,
          stall_id: state.stallId,
          event_id: state.eventId,
          provider: 'google_drive',
          connected_by_user_id: state.userId,
          access_token: encryptToken(tokens.access_token),
          refresh_token: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
          token_expires_at: expiresAt.toISOString(),
          drive_account_email: email,
          status: 'active',
          connected_at: new Date().toISOString()
        })

        return { _redirect: '/vendor?connected=google' }
      } catch (err) {
        console.error('[drive] Google callback error:', err.message)
        return { _redirect: '/vendor?drive_error=server_error' }
      }
    }
  })

  router.addRoute({
    id: 'drive-onedrive-callback',
    method: 'GET',
    path: '/auth/drive/onedrive/callback',
    authRequired: false,
    handler: async ({ repos, query }) => {
      const { code, state: rawState, error } = query
      if (error) return { _redirect: '/vendor?drive_error=' + encodeURIComponent(error) }
      if (!code || !rawState) return { _redirect: '/vendor?drive_error=missing_params' }

      const state = parseState(rawState)
      if (!state?.stallId || !state?.tenantId) {
        return { _redirect: '/vendor?drive_error=invalid_state' }
      }

      try {
        const tokens = await exchangeOneDriveCode(code)
        if (!tokens.access_token) {
          return { _redirect: '/vendor?drive_error=token_exchange_failed' }
        }
        const email = await getOneDriveUserEmail(tokens.access_token)
        const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000)

        const existing = await repos.stallDriveConnections.findByStall(state.stallId, state.tenantId)
        for (const conn of existing.filter(c => c.status === 'active')) {
          await repos.stallDriveConnections.setStatus(conn.id, 'disconnected')
        }

        await repos.stallDriveConnections.create({
          id: 'sdc-' + shortId(),
          tenant_id: state.tenantId,
          stall_id: state.stallId,
          event_id: state.eventId,
          provider: 'onedrive',
          connected_by_user_id: state.userId,
          access_token: encryptToken(tokens.access_token),
          refresh_token: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
          token_expires_at: expiresAt.toISOString(),
          drive_account_email: email,
          status: 'active',
          connected_at: new Date().toISOString()
        })

        return { _redirect: '/vendor?connected=onedrive' }
      } catch (err) {
        console.error('[drive] OneDrive callback error:', err.message)
        return { _redirect: '/vendor?drive_error=server_error' }
      }
    }
  })

  // ── Connection Management ─────────────────────────────────────────────────────

  router.addRoute({
    id: 'stall-drive-connection-get',
    method: 'GET',
    path: '/stalls/:stallId/drive/connection',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, resources, principal }) => {
      const conn = await repos.stallDriveConnections.findActive(
        resources.stall.id, principal.tenant_id
      )
      if (!conn) return { connected: false }
      return {
        connected: true,
        provider: conn.provider,
        drive_account_email: conn.drive_account_email,
        status: conn.status,
        connected_at: conn.connected_at,
        last_refreshed_at: conn.last_refreshed_at ?? null
      }
    }
  })

  router.addRoute({
    id: 'stall-drive-disconnect',
    method: 'DELETE',
    path: '/stalls/:stallId/drive/disconnect',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, resources, principal }) => {
      const conn = await repos.stallDriveConnections.findActive(
        resources.stall.id, principal.tenant_id
      )
      if (!conn) throw new HttpError(404, 'No active connection to disconnect')
      await repos.stallDriveConnections.setStatus(conn.id, 'disconnected')
      return { disconnected: true }
    }
  })

  // ── Folder Browsing ──────────────────────────────────────────────────────────

  router.addRoute({
    id: 'stall-drive-folders-list',
    method: 'GET',
    path: '/stalls/:stallId/drive/folders',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, resources, principal, query }) => {
      const conn = await repos.stallDriveConnections.findActive(
        resources.stall.id, principal.tenant_id
      )
      const accessToken = await getDecryptedAccessToken(repos, conn)
      const parentId = query.parent_id ?? 'root'

      let data
      if (conn.provider === 'google_drive') {
        data = await listGoogleFolders(accessToken, parentId)
        return { provider: 'google_drive', folders: (data.files ?? []).map(f => ({ id: f.id, name: f.name, web_view_link: f.webViewLink })) }
      } else {
        data = await listOneDriveFolders(accessToken, parentId)
        return { provider: 'onedrive', folders: (data.value ?? []).map(f => ({ id: f.id, name: f.name, web_view_link: f.webUrl })) }
      }
    }
  })

  // ── Shared Folder Management ─────────────────────────────────────────────────

  router.addRoute({
    id: 'stall-drive-shared-folders-create',
    method: 'POST',
    path: '/stalls/:stallId/drive/shared-folders',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, resources, principal, body }) => {
      const { folder_id, folder_name, folder_path, default_access, allow_download, allow_view } = body
      if (!folder_id || !folder_name) throw new HttpError(400, 'folder_id and folder_name are required')
      const conn = await repos.stallDriveConnections.findActive(
        resources.stall.id, principal.tenant_id
      )
      if (!conn) throw new HttpError(409, 'No active drive connection for this stall')

      return repos.stallSharedFolders.create({
        id: 'ssf-' + shortId(),
        tenant_id: principal.tenant_id,
        stall_id: resources.stall.id,
        event_id: resources.stall.event_id,
        connection_id: conn.id,
        provider: conn.provider,
        folder_id,
        folder_name,
        folder_path: folder_path ?? null,
        default_access: default_access ?? 'open',
        allow_download: allow_download !== false,
        allow_view: allow_view !== false,
        status: 'active',
        sort_order: 0
      })
    },
    statusCode: 201
  })

  router.addRoute({
    id: 'stall-drive-shared-folders-list',
    method: 'GET',
    path: '/stalls/:stallId/drive/shared-folders',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, resources, principal }) => {
      const folders = await repos.stallSharedFolders.listActive(
        resources.stall.id, principal.tenant_id
      )
      return { items: folders }
    }
  })

  router.addRoute({
    id: 'stall-drive-shared-folders-update',
    method: 'PATCH',
    path: '/stalls/:stallId/drive/shared-folders/:folderId',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      const folder = await repos.stallSharedFolders.findById(params.folderId)
      if (!folder || folder.stall_id !== stall.id) throw new HttpError(404, 'Shared folder not found')
      return { stall, folder }
    },
    handler: async ({ repos, resources, body }) => {
      const allowed = ['folder_name', 'default_access', 'allow_download', 'allow_view', 'status', 'sort_order']
      const updates = Object.fromEntries(
        Object.entries(body).filter(([k]) => allowed.includes(k))
      )
      return repos.stallSharedFolders.update(resources.folder.id, updates)
    }
  })

  router.addRoute({
    id: 'stall-drive-shared-folders-delete',
    method: 'DELETE',
    path: '/stalls/:stallId/drive/shared-folders/:folderId',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      const folder = await repos.stallSharedFolders.findById(params.folderId)
      if (!folder || folder.stall_id !== stall.id) throw new HttpError(404, 'Shared folder not found')
      return { stall, folder }
    },
    handler: async ({ repos, resources }) => {
      await repos.stallSharedFolders.archive(resources.folder.id)
      return { archived: true }
    }
  })

  // ── Access Grants ────────────────────────────────────────────────────────────

  router.addRoute({
    id: 'stall-drive-access-grants-create',
    method: 'POST',
    path: '/stalls/:stallId/drive/access-grants',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, resources, principal, body }) => {
      const { attendee_id, interaction_id, folder_ids } = body
      const tenantId = principal.tenant_id
      const expiryDays = parseInt(process.env.DRIVE_ACCESS_TOKEN_EXPIRY_DAYS ?? '30', 10)
      const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)

      let folders = await repos.stallSharedFolders.listActive(resources.stall.id, tenantId)
      if (folder_ids?.length) {
        folders = folders.filter(f => folder_ids.includes(f.id))
      }
      if (!folders.length) throw new HttpError(404, 'No active shared folders to grant access to')

      const grants = []
      for (const folder of folders) {
        const token = randomBytes(32).toString('hex')
        const grant = await repos.stallFolderAccess.create({
          id: 'sfa-' + shortId(),
          tenant_id: tenantId,
          stall_id: resources.stall.id,
          event_id: resources.stall.event_id,
          folder_id: folder.id,
          attendee_id: attendee_id ?? null,
          interaction_id: interaction_id ?? null,
          access_token: token,
          access_token_expires_at: expiresAt.toISOString(),
          granted_by: 'manual',
          status: 'active'
        })
        grants.push({ ...grant, folder_name: folder.folder_name })
      }
      const baseUrl = process.env.BASE_URL ?? ''
      return {
        grants: grants.map(g => ({
          id: g.id,
          folder_id: g.folder_id,
          folder_name: g.folder_name,
          access_token: g.access_token,
          access_url: baseUrl + '/docs/' + g.access_token,
          expires_at: expiresAt.toISOString()
        }))
      }
    },
    statusCode: 201
  })

  router.addRoute({
    id: 'stall-drive-access-grants-list',
    method: 'GET',
    path: '/stalls/:stallId/drive/access-grants',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, resources, principal }) => {
      const grants = await repos.stallFolderAccess.findByStall(
        resources.stall.id, principal.tenant_id
      )
      return { items: grants }
    }
  })

  router.addRoute({
    id: 'stall-drive-access-grant-revoke',
    method: 'POST',
    path: '/stalls/:stallId/drive/access-grants/:grantId/revoke',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, body, params, principal }) => {
      const grant = await repos.stallFolderAccess.updateStatus(params.grantId, 'revoked', body.reason ?? null)
      await repos.stallFolderAccess.logEvent({
        tenant_id: principal.tenant_id,
        folder_access_id: params.grantId,
        event_type: 'access_revoked'
      })
      return { revoked: true, grant }
    }
  })

  router.addRoute({
    id: 'stall-drive-access-grant-suspend',
    method: 'POST',
    path: '/stalls/:stallId/drive/access-grants/:grantId/suspend',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, params, principal }) => {
      const grant = await repos.stallFolderAccess.updateStatus(params.grantId, 'suspended', null)
      await repos.stallFolderAccess.logEvent({
        tenant_id: principal.tenant_id,
        folder_access_id: params.grantId,
        event_type: 'access_suspended'
      })
      return { suspended: true, grant }
    }
  })

  router.addRoute({
    id: 'stall-drive-access-grant-restore',
    method: 'POST',
    path: '/stalls/:stallId/drive/access-grants/:grantId/restore',
    allowedRoles: ['vendor_manager', 'organizer_admin', 'platform_admin'],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId)
      if (!stall) throw new HttpError(404, 'Stall not found')
      return { stall }
    },
    handler: async ({ repos, params, principal }) => {
      const grant = await repos.stallFolderAccess.updateStatus(params.grantId, 'active', null)
      await repos.stallFolderAccess.logEvent({
        tenant_id: principal.tenant_id,
        folder_access_id: params.grantId,
        event_type: 'access_restored'
      })
      return { restored: true, grant }
    }
  })

  // ── Attendee Document Access (token-based, no auth) ───────────────────────────

  router.addRoute({
    id: 'docs-access-folders',
    method: 'GET',
    path: '/docs/:accessToken/folders',
    authRequired: false,
    handler: async ({ repos, params }) => {
      const grant = await repos.stallFolderAccess.findByToken(params.accessToken)
      if (!grant) throw new HttpError(404, 'Access link not found')

      if (grant.status === 'revoked') throw new HttpError(410, 'Access has been removed')
      if (grant.status === 'suspended') throw new HttpError(403, 'Access is temporarily unavailable')
      const now = new Date()
      if (grant.access_token_expires_at && new Date(grant.access_token_expires_at) < now) {
        throw new HttpError(410, 'Access link has expired')
      }

      await repos.stallFolderAccess.incrementAccessCount(grant.id)
      await repos.stallFolderAccess.logEvent({
        tenant_id: grant.tenant_id,
        folder_access_id: grant.id,
        event_type: 'link_opened'
      })

      // Get all folders this attendee can access (shares same stall)
      const allGrants = grant.interaction_id
        ? await repos.stallFolderAccess.findAllByInteraction(grant.tenant_id, grant.interaction_id)
        : [grant]

      const folders = []
      for (const g of allGrants.filter(g => g.status === 'active')) {
        const folder = await repos.stallSharedFolders.findById(g.folder_id)
        if (folder && folder.status === 'active') {
          folders.push({
            id: g.id,
            folder_name: folder.folder_name,
            allow_view: folder.allow_view,
            allow_download: folder.allow_download,
            provider: folder.provider,
            access_token: g.access_token,
            expires_at: g.access_token_expires_at
          })
        }
      }

      return {
        stall_id: grant.stall_id,
        folders,
        expires_at: grant.access_token_expires_at
      }
    }
  })

  router.addRoute({
    id: 'docs-files-list',
    method: 'GET',
    path: '/docs/:accessToken/folders/:folderId/files',
    authRequired: false,
    handler: async ({ repos, params }) => {
      const grant = await repos.stallFolderAccess.findByToken(params.accessToken)
      if (!grant) throw new HttpError(404, 'Access link not found')
      if (grant.status === 'revoked') throw new HttpError(410, 'Access has been removed')
      if (grant.status === 'suspended') throw new HttpError(403, 'Access is temporarily unavailable')
      if (grant.access_token_expires_at && new Date(grant.access_token_expires_at) < new Date()) {
        throw new HttpError(410, 'Access link has expired')
      }
      if (grant.folder_id !== params.folderId) throw new HttpError(403, 'Token does not grant access to this folder')

      const connection = await repos.stallDriveConnections.findActive(grant.stall_id, grant.tenant_id)
      if (!connection) throw new HttpError(503, 'Drive connection unavailable')
      const accessToken = decryptToken(connection.access_token)

      let files
      if (connection.provider === 'google_drive') {
        const data = await listGoogleFiles(accessToken, grant.drive_folder_id)
        files = (data.files ?? []).map(f => ({
          id: f.id,
          name: f.name,
          mime_type: f.mimeType,
          size: f.size ?? null,
          web_view_link: f.webViewLink,
          modified_at: f.modifiedTime
        }))
      } else {
        const data = await listOneDriveFiles(accessToken, grant.drive_folder_id)
        files = (data.value ?? []).map(f => ({
          id: f.id,
          name: f.name,
          mime_type: f.file?.mimeType ?? null,
          size: f.size ?? null,
          web_view_link: f.webUrl,
          modified_at: f.lastModifiedDateTime
        }))
      }
      return { folder_id: params.folderId, files }
    }
  })

  router.addRoute({
    id: 'docs-file-view',
    method: 'GET',
    path: '/docs/:accessToken/folders/:folderId/files/:fileId/view',
    authRequired: false,
    handler: async ({ repos, params, headers }) => {
      const grant = await repos.stallFolderAccess.findByToken(params.accessToken)
      if (!grant) throw new HttpError(404, 'Access link not found')
      if (grant.status === 'revoked') throw new HttpError(410, 'Access has been removed')
      if (grant.status === 'suspended') throw new HttpError(403, 'Access is temporarily unavailable')
      if (grant.access_token_expires_at && new Date(grant.access_token_expires_at) < new Date()) {
        throw new HttpError(410, 'Access link has expired')
      }
      if (!grant.allow_view) throw new HttpError(403, 'Viewing is not permitted for this folder')
      if (grant.folder_id !== params.folderId) throw new HttpError(403, 'Token does not grant access to this folder')

      const connection = await repos.stallDriveConnections.findActive(grant.stall_id, grant.tenant_id)
      if (!connection) throw new HttpError(503, 'Drive connection unavailable')

      await repos.stallFolderAccess.logEvent({
        tenant_id: grant.tenant_id,
        folder_access_id: grant.id,
        event_type: 'file_viewed',
        file_id: params.fileId,
        ip_address: headers['x-forwarded-for'] ?? null,
        user_agent: headers['user-agent'] ?? null
      })

      let viewer_url
      if (connection.provider === 'google_drive') {
        viewer_url = getGoogleViewerUrl(params.fileId)
      } else {
        // For OneDrive, we need the webUrl — client passes it or we use the fileId as webUrl
        viewer_url = getOneDriveViewerUrl(params.fileId)
      }
      return { viewer_url, file_id: params.fileId }
    }
  })

  router.addRoute({
    id: 'docs-file-download',
    method: 'GET',
    path: '/docs/:accessToken/folders/:folderId/files/:fileId/download',
    authRequired: false,
    handler: async ({ repos, params, headers }) => {
      const grant = await repos.stallFolderAccess.findByToken(params.accessToken)
      if (!grant) throw new HttpError(404, 'Access link not found')
      if (grant.status === 'revoked') throw new HttpError(410, 'Access has been removed')
      if (grant.status === 'suspended') throw new HttpError(403, 'Access is temporarily unavailable')
      if (grant.access_token_expires_at && new Date(grant.access_token_expires_at) < new Date()) {
        throw new HttpError(410, 'Access link has expired')
      }
      if (!grant.allow_download) throw new HttpError(403, 'Download is not permitted for this folder')
      if (grant.folder_id !== params.folderId) throw new HttpError(403, 'Token does not grant access to this folder')

      const connection = await repos.stallDriveConnections.findActive(grant.stall_id, grant.tenant_id)
      if (!connection) throw new HttpError(503, 'Drive connection unavailable')
      const accessToken = decryptToken(connection.access_token)

      await repos.stallFolderAccess.logEvent({
        tenant_id: grant.tenant_id,
        folder_access_id: grant.id,
        event_type: 'file_downloaded',
        file_id: params.fileId,
        ip_address: headers['x-forwarded-for'] ?? null,
        user_agent: headers['user-agent'] ?? null
      })

      let download_url
      if (connection.provider === 'google_drive') {
        download_url = `https://www.googleapis.com/drive/v3/files/${params.fileId}?alt=media&access_token=${encodeURIComponent(accessToken)}`
      } else {
        // For OneDrive return the pre-authenticated download URL
        const filesData = await listOneDriveFiles(accessToken, grant.drive_folder_id)
        const file = (filesData.value ?? []).find(f => f.id === params.fileId)
        download_url = file?.['@microsoft.graph.downloadUrl'] ?? file?.webUrl ?? null
      }
      return { download_url, file_id: params.fileId }
    }
  })
}
