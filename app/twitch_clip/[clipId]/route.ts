import { NextResponse } from "next/server"

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
  request: Request,
  { params }: { params: Promise<{ clipId: string }> }
) {
  const { clipId } = await params

  // first, verify if we have a valid access token to query API with
  const validationResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: [['Authorization', `Bearer ${currentAccessToken}`]]
  })

  if (!validationResponse.ok) {
    const requestNewTokenResponse = await fetch(`https://id.twitch.tv/oauth2/token?${requestNewTokenParams}`, {
      method: 'POST',
    })

    if (!requestNewTokenResponse.ok) {
      return Response.json( { error: { message: 'Could not retrieve working access token' }} )
    }

    const bodyRequestNewToken = await requestNewTokenResponse.json()
    currentAccessToken = bodyRequestNewToken.access_token
  }

  // use graphql twitch endpoint
  const requestClipMetaResponse = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: [
          ['Client-ID', 'kimne78kx3ncx6brgo4mv6wki5h1ko'],
          ['Authorization', `Bearer ${currentAccessToken}`],
          ['Content-Type', 'application/json']
      ],
      body: JSON.stringify([
          {
              "operationName": "VideoPlayerStreamInfoOverlayClip",
              "variables": {"slug": clipId},
              "extensions": {
                  "persistedQuery": {
                      "version": 1,
                      "sha256Hash": "fcefd8b2081e39d16cbdc94bc82142df01b143bb296f0043262c44c37dbd1f63",
                  }
              },
          },
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
  
  if (!requestClipMetaResponse.ok) {
      return Response.json( { error: { message: 'Could not query clip information: ' + requestClipMetaResponse.statusText + ' - the API request to Twitch seems to have errored.' }} )
  }

  const requestClipMetaBody = await requestClipMetaResponse.json()

  if (!requestClipMetaBody[0].data.clip) {
    return Response.json( { error: { message: `Could not query clip information. The provided clipId, "${clipId}" is likely invalid.` }} )
  }

  console.log(JSON.stringify(requestClipMetaBody, null, 4))

  const clipMetaData = requestClipMetaBody[0].data.clip
  const clipVideoPlaybackData = requestClipMetaBody[1].data.clip

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
          <meta property="theme-color" content="#B868F2">
          <meta property="og:title" content="🎞️ ${escapeString(clipMetaData.broadcaster.displayName)} - ${escapeString(clipMetaData.title)}">
          <meta property="og:type" content="video">
          <meta property="og:site_name" content="👁️ Views: ${clipMetaData.viewCount} - test">
          <meta property="og:url" content="${'https://clips.twitch.tv/' + clipId}">
          <meta property="og:video" content="${escapeString(authorizedVideoURL)}">
          <meta property="og:video:secure_url" content="${escapeString(authorizedVideoURL)}">
          <meta property="og:video:type" content="video/mp4">
      </head>
    </html>
    `,
    { status: 200, headers: { 'content-type': 'text/html' }} 
  )
  
}