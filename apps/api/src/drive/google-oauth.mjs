import { decryptToken } from './encryption.mjs'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
]

export function getGoogleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: Buffer.from(JSON.stringify(state)).toString('base64url')
  })
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString()
}

export async function exchangeGoogleCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  })
  return res.json()
}

export async function refreshGoogleToken(encryptedRefreshToken) {
  const refreshToken = decryptToken(encryptedRefreshToken)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  })
  return res.json()
}

export async function getGoogleUserEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken }
  })
  const data = await res.json()
  return data.email ?? null
}

export async function listGoogleFolders(accessToken, parentId = 'root') {
  const q = parentId === 'root'
    ? "mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false"
    : `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,parents,webViewLink)',
    pageSize: '100',
    orderBy: 'name'
  })
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/files?' + params.toString(),
    { headers: { Authorization: 'Bearer ' + accessToken } }
  )
  return res.json()
}

export async function listGoogleFiles(accessToken, folderId) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
    fields: 'files(id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,modifiedTime)',
    pageSize: '100',
    orderBy: 'name'
  })
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/files?' + params.toString(),
    { headers: { Authorization: 'Bearer ' + accessToken } }
  )
  return res.json()
}

export function getGoogleViewerUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/preview`
}
