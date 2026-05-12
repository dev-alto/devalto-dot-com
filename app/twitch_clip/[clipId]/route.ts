import { NextResponse } from 'next/server'
import { type NextRequest } from 'next/server'

import { Client as MinioClient, S3Error } from 'minio'

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



let currentTwitchAccessToken = ''

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clipId: string }> }
) {
  const { clipId } = await params
  
  const searchParams = request.nextUrl.searchParams
  const stripped = searchParams.get('stripped')

  // first, verify if we have a valid access token to query API with
  const timer_startTimestamp = performance.now()

  const validationResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: [['Authorization', `Bearer ${currentTwitchAccessToken}`]]
  })

  // if not valid, go recycle current token
  if (!validationResponse.ok) {
    const requestNewTokenResponse = await fetch(`https://id.twitch.tv/oauth2/token?${requestNewTokenParams}`, {
      method: 'POST'
    })

    if (!requestNewTokenResponse.ok) {
      return Response.json( { error: { message: 'Could not retrieve a new access token from id.twitch.tv endpoint during token recycling.' }} )
    }

    const bodyRequestNewToken = await requestNewTokenResponse.json()
    currentTwitchAccessToken = bodyRequestNewToken.access_token
  }

  const requestClipMetaData = await fetch(`https://api.twitch.tv/helix/clips?id=${clipId}`, {
    headers: [['Client-Id', process.env.TWITCH_CLIENT_ID as string ], ['Authorization', `Bearer ${currentTwitchAccessToken}`]]
  })

  // check if requesting clip if Twitch succeeds; validating if clipId and therefore clip is valid
  if (!requestClipMetaData.ok) {
    return new NextResponse(
      `
        <html>
          <head>
            <meta property="charset" content="utf-8">
            <meta property="theme-color" content="#FB4545">
            <meta property="og:title" content="A server-side exception has occured.">
            <meta property="og:description" content="The provided clipId, '${clipId}', could not be indexed from Twitch or is invalid.\n\n📬 Think this is in error? Contact @devalto for further investigation.">
          </head>
          <body>
            The provided clipId, '${clipId}', could not be indexed from Twitch or is invalid. Think this is in error? Contact @devalto for further investigation.
          </body>
        </html>
      `,
      { status: 200, headers: { 'content-type': 'text/html' }}
    )
  }

  const requestClipMetaBody = await requestClipMetaData.json()
  const requestClipMetaBodyData = requestClipMetaBody.data[0]

  const expectedObjectClipName = `${clipId}-1.mp4`

  let queryS3Error = ''

  console.log('timer_startTimestamp "token validation + query clip": ' + (performance.now() - timer_startTimestamp))
  const timer_startQueryClipObject = performance.now()

  // attempt promise query to get item from bucket; will throw NoSuchKey S3Error if not foun.
  // at that point we can start the process of importing this new missing clip object to the store.
  const queriedClipObject = await minioClient.getObject(CLIPS_BUCKET_NAME, expectedObjectClipName).catch(async (err: unknown) => {
    if (!(err instanceof S3Error)) {
      queryS3Error = `Encountered non-S3 error: ${err}`
      return
    }

    if (err.code !== 'NoSuchKey') {
      queryS3Error = `Encountered S3 error: ${err}`
      return
    }

    console.log('New clip detected, strating process to fetch and add it to storage bucket.')

    const requestGraphQClipMetaResponse = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: [
        ['Client-ID', 'kimne78kx3ncx6brgo4mv6wki5h1ko'],
        ['Authorization', `Bearer ${currentTwitchAccessToken}`],
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
    
    if (!requestGraphQClipMetaResponse.ok) {
        return Response.json( { error: { message: 'Could not query clip information: ' + requestGraphQClipMetaResponse.statusText + ' - the API request to Twitch seems to have errored.' }} )
    }

    const requestGQLClipMetaBody = await requestGraphQClipMetaResponse.json()

    // console.log('helios clip data body:')
    // console.log(JSON.stringify(requestClipMetaBody, null, 4))

    // console.log('graphql data body:')
    // console.log(JSON.stringify(requestGQLClipMetaBody, null, 4))

    const clipVideoPlaybackData = requestGQLClipMetaBody[0].data.clip

    const baseVideoURL = clipVideoPlaybackData.videoQualities[0].sourceURL

    const playbackAccessToken = clipVideoPlaybackData.playbackAccessToken

    const authorizedVideoURL = `${baseVideoURL}?sig=${playbackAccessToken.signature}&token=${encodeURI(playbackAccessToken.value)}`

    console.log('timer_startQueryClipObject: ' + (performance.now() - timer_startQueryClipObject))
    const timer_startFetchAndImportToStore = performance.now()

    const twitchMediaClipFile = await fetch(authorizedVideoURL)

    const twitchMediaClipBuffer = Buffer.from(await twitchMediaClipFile.arrayBuffer())

    console.log('timer_startFetchAndImportToStore "initial fetch and to buffer": ' + (performance.now() - timer_startFetchAndImportToStore))

    minioClient.putObject(CLIPS_BUCKET_NAME, expectedObjectClipName, twitchMediaClipBuffer, twitchMediaClipBuffer.byteLength).then(() => {
        console.log('timer_startFetchAndImportToStore "putObject complete": ' + (performance.now() - timer_startFetchAndImportToStore))
    })
  })

  if (queriedClipObject) {
    console.log('Clip already found in twitch-clips bucket.')
  }

  console.log('timer_startFetchAndImportToStore "total": ' + (performance.now() - timer_startQueryClipObject))

  if (queryS3Error) {
      return new NextResponse(
      `
        <html>
          <head>
            <meta property="charset" content="utf-8">
            <meta property="theme-color" content="#FB4545">
            <meta property="og:title" content="A server-side exception has occured.">
            <meta property="og:description" content="Could not query clip from storage bucket, or could not retrieve clip media from Twitch's API.\n\n📬 Think this is in error? Contact @devalto for further investigation.">

          </head>
          <body>
            Could not query clip from storage bucket, or could not retrieve clip media from Twitch's API. Think this is in error? Contact @devalto for further investigation.
          </body>
        </html>
      `,
      { status: 200, headers: { 'content-type': 'text/html' }}
    )
  }

  const storageWebLink = escapeString(process.env.S3_STORAGE_CLIPS_WEB_ENDPOINT + expectedObjectClipName)

  console.log('total: ' + (performance.now() - timer_startTimestamp))

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
        </head>
      </html>
    `,
    { status: 200, headers: { 'content-type': 'text/html' }} 
  )
  
}