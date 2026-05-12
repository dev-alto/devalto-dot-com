import { NextResponse } from 'next/server'
import { type NextRequest } from 'next/server'

import { Client as MinioClient } from 'minio'

const CLIPS_BUCKET_NAME = 'twitch-clips'

const requestNewTokenParams = new URLSearchParams({
  client_id: process.env.TWITCH_CLIENT_ID as string,
  client_secret: process.env.TWITCH_CLIENT_SECRET as string,
  grant_type: 'client_credentials',
})

const minioClient = new MinioClient({
  endPoint: process.env.S3_STORAGE_ENDPOINT as string,
  region: 'garage',
  pathStyle: true,
  useSSL: true,
  accessKey: process.env.S3_STORAGE_ACCESS_KEY as string,
  secretKey: process.env.S3_STORAGE_SECRET_KEY as string,
})

// look into just using url encoding
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
  const bmark_1 = performance.now()

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

  const requestClipMetaData = await fetch(`https://api.twitch.tv/helix/clips?id=${clipId}`, {
    headers: [['Client-Id', process.env.TWITCH_CLIENT_ID as string ], ['Authorization', `Bearer ${currentAccessToken}`]]
  })

  const requestClipMetaBody = await requestClipMetaData.json()
  const requestClipMetaBodyData = requestClipMetaBody.data[0]

  // console.log('b1: ' + (performance.now() - bmark_1))

  const expectedObjectClipName = `${clipId}.mp4`

  try {

    // check to see if clip is already kept in object storage
    const objectClip = await minioClient.getObject(CLIPS_BUCKET_NAME, expectedObjectClipName)

    if (!objectClip.readable) {

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
            'operationName': 'VideoAccessToken_Clip',
            'variables': {'platform': 'web', 'slug': clipId},
            'extensions': {
                'persistedQuery': {
                    'version': 1,
                    'sha256Hash': '6fd3af2b22989506269b9ac02dd87eb4a6688392d67d94e41a6886f1e9f5c00f',
                }
            },
          },
        ])
      })

      console.log('b2: ' + (performance.now() - bmark_1))
      
      if (!requestGraphQClipMetaResponse.ok || !requestClipMetaData.ok) {
          return Response.json( { error: { message: 'Could not query clip information: ' + requestGraphQClipMetaResponse.statusText + ' - the API request to Twitch seems to have errored.' }} )
      }

      const requestGraphpQClipMetaBody = await requestGraphQClipMetaResponse.json()

      console.log('helios clip data body:')
      console.log(JSON.stringify(requestClipMetaBody, null, 4))

      console.log('graphql data body:')
      console.log(JSON.stringify(requestGraphpQClipMetaBody, null, 4))

      if (!requestGraphpQClipMetaBody[0].data?.clip) {
        return Response.json( { error: { message: `Could not query clip information. The provided clipId, "${clipId}" is likely invalid.` }} )
      }

      console.log('b3: ' + (performance.now() - bmark_1))

      const clipVideoPlaybackData = requestGraphpQClipMetaBody[0].data.clip

      const baseVideoURL = clipVideoPlaybackData.videoQualities[0].sourceURL
      console.log(baseVideoURL)

      const playbackAccessToken = clipVideoPlaybackData.playbackAccessToken
      console.log(playbackAccessToken)

      const authorizedVideoURL = `${baseVideoURL}?sig=${playbackAccessToken.signature}&token=${encodeURI(playbackAccessToken.value)}`
      console.log(authorizedVideoURL)

      const twitchMediaFile = await fetch(authorizedVideoURL)

      const twitchMediaBuffer = Buffer.from(await twitchMediaFile.arrayBuffer())

      console.log('b4: ' + (performance.now() - bmark_1))

      await minioClient.putObject(CLIPS_BUCKET_NAME, expectedObjectClipName, twitchMediaBuffer, twitchMediaBuffer.byteLength)
    } else {
      console.log('cache hit!')
    }
  } catch(err) {
    console.log(err)
  }

  const storageWebLink = escapeString(process.env.S3_STORAGE_CLIPS_WEB_ENDPOINT + expectedObjectClipName)

  console.log('b6: ' + (performance.now() - bmark_1))

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
          <meta property="og:video" content="${storageWebLink}">
          <meta property="og:video:secure_url" content="${storageWebLink}">
          <meta property="og:video:type" content="video/mp4">
          <meta http-equiv='refresh' content='0; URL="${'https://clips.twitch.tv/' + clipId}"'>
          
          <meta http-equiv='refresh' content='0; URL="${'https://clips.twitch.tv/' + clipId}"'>
        </head>
      </html>
    `,
    { status: 200, headers: { 'content-type': 'text/html' }} 
  )
  
}