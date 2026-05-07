import { decryptToken } from './encryption.mjs'

function tenantId() {
  return process.env.ONEDRIVE_TENANT_ID ?? 'common'
}

export function getOneDriveAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.ONEDRIVE_CLIENT_ID,
    redirect_uri: process.env.ONEDRIVE_REDIRECT_URI,
    response_type: 'code',
    scope: 'Files.Read Files.Read.All User.Read offline_access',
    state: Buffer.from(JSON.stringify(state)).toString('base64url')
  })
  return `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/authorize?` + params.toString()
}

export async function exchangeOneDriveCode(code) {
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.ONEDRIVE_CLIENT_ID,
        client_secret: process.env.ONEDRIVE_CLIENT_SECRET,
        redirect_uri: process.env.ONEDRIVE_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    }
  )
  return res.json()
}

export async function refreshOneDriveToken(encryptedRefreshToken) {
  const refreshToken = decryptToken(encryptedRefreshToken)
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: process.env.ONEDRIVE_CLIENT_ID,
        client_secret: process.env.ONEDRIVE_CLIENT_SECRET,
        grant_type: 'refresh_token',
        scope: 'Files.Read Files.Read.All User.Read offline_access'
      })
    }
  )
  return res.json()
}

export async function getOneDriveUserEmail(accessToken) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: 'Bearer ' + accessToken }
  })
  const data = await res.json()
  return data.mail ?? data.userPrincipalName ?? null
}

export async function listOneDriveFolders(accessToken, parentId = 'root') {
  const url = parentId === 'root'
    ? 'https://graph.microsoft.com/v1.0/me/drive/root/children?$filter=folder ne null&$select=id,name,folder,webUrl&$orderby=name'
    : `https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children?$filter=folder ne null&$select=id,name,folder,webUrl&$orderby=name`
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } })
  return res.json()
}

export async function listOneDriveFiles(accessToken, folderId) {
  const url = `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children` +
    `?$select=id,name,file,size,webUrl,@microsoft.graph.downloadUrl,lastModifiedDateTime&$orderby=name`
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } })
  return res.json()
}

export function getOneDriveViewerUrl(fileWebUrl) {
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fileWebUrl)}`
}
