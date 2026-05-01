import { NextResponse } from 'next/server'
import { type NextRequest } from 'next/server'

const requestNewTokenParams = new URLSearchParams({
  client_id: process.env.TWITCH_CLIENT_ID as string,
  client_secret: process.env.TWITCH_CLIENT_SECRET as string,
  grant_type: 'client_credentials',
})

const escapeString = function(string: string) { 
  return string
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

let currentAccessToken = ''

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clipId: string }> }
) {
  const { clipId } = await params
  
  const searchParams = request.nextUrl.searchParams
  const stripped = searchParams.get('stripped')

  // first, verify if we have a valid access token to query API with
  const validationResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: [['Authorization', `Bearer ${currentAccessToken}`]]
  })

  if (!validationResponse.ok) {
    const requestNewTokenResponse = await fetch(`https://id.twitch.tv/oauth2/token?${requestNewTokenParams}`, {
      method: 'POST'
    })

    if (!requestNewTokenResponse.ok) {
      return Response.json( { error: { message: 'Could not retrieve working access token' }} )
    }

    const bodyRequestNewToken = await requestNewTokenResponse.json()
    currentAccessToken = bodyRequestNewToken.access_token
  }

  // use graphql twitch endpoint
  const requestGraphQClipMetaResponse = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: [
      ['Client-ID', 'kimne78kx3ncx6brgo4mv6wki5h1ko'],
      ['Authorization', `Bearer ${currentAccessToken}`],
      ['Content-Type', 'application/json']
    ],
    body: JSON.stringify([
      {
        "operationName": "VideoAccessToken_Clip",
        "variables": {"platform": "web", "slug": clipId},
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": "6fd3af2b22989506269b9ac02dd87eb4a6688392d67d94e41a6886f1e9f5c00f",
            }
        },
      },
    ])
  })

  const requestClipMetaData = await fetch(`https://api.twitch.tv/helix/clips?id=${clipId}`, {
    headers: [['Client-Id', process.env.TWITCH_CLIENT_ID as string ], ['Authorization', `Bearer ${currentAccessToken}`]]
  })
  
  if (!requestGraphQClipMetaResponse.ok || !requestClipMetaData.ok) {
      return Response.json( { error: { message: 'Could not query clip information: ' + requestGraphQClipMetaResponse.statusText + ' - the API request to Twitch seems to have errored.' }} )
  }

  const requestGraphpQClipMetaBody = await requestGraphQClipMetaResponse.json()
  const requestClipMetaBody = await requestClipMetaData.json()
  const requestClipMetaBodyData = requestClipMetaBody.data[0]

  console.log('helios clip data body:')
  console.log(JSON.stringify(requestClipMetaBody, null, 4))

  console.log('graphql data body:')
  console.log(JSON.stringify(requestGraphpQClipMetaBody, null, 4))

  if (!requestGraphpQClipMetaBody[0].data?.clip) {
    return Response.json( { error: { message: `Could not query clip information. The provided clipId, "${clipId}" is likely invalid.` }} )
  }

  const clipVideoPlaybackData = requestGraphpQClipMetaBody[0].data.clip

  const baseVideoURL = clipVideoPlaybackData.videoQualities[0].sourceURL
  console.log(baseVideoURL)

  const playbackAccessToken = clipVideoPlaybackData.playbackAccessToken
  console.log(playbackAccessToken)

  const authorizedVideoURL = `${baseVideoURL}?sig=${playbackAccessToken.signature}&token=${encodeURI(playbackAccessToken.value)}`
  console.log(authorizedVideoURL)

  return new NextResponse(
    `
      <html>
        <head>
          <meta property="charset" content="utf-8">
          <meta property="theme-color" content="#9045fb">
          <meta property="og:url" content="${'https://clips.twitch.tv/' + clipId}">
          <meta property="og:title" content='${escapeString(requestClipMetaBodyData.broadcaster_name)} - "${escapeString(requestClipMetaBodyData.title)}"'>
          ${!stripped && `
          <meta property="og:site_name" content="👁️ ${requestClipMetaBodyData.view_count} view${requestClipMetaBodyData.view_count !== 1 ? 's' : ''} ︱ ⏱️${requestClipMetaBodyData.duration}s ︱🎬 by (@${requestClipMetaBodyData.creator_name})">
          `}
          <meta property="og:type" content="video">
          <meta property="og:video" content="${escapeString(authorizedVideoURL)}">
          <meta property="og:video:secure_url" content="${escapeString(authorizedVideoURL)}">
          <meta property="og:video:type" content="video/mp4">
          <meta http-equiv='refresh' content='0; URL="${'https://clips.twitch.tv/' + clipId}"'>
          
          <meta http-equiv='refresh' content='0; URL="${'https://clips.twitch.tv/' + clipId}"'>
        </head>
      </html>
    `,
    { status: 200, headers: { 'content-type': 'text/html' }} 
  )
  
}