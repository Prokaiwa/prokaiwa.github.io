import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url)
    const messageId = url.searchParams.get('messageId')

    if (!messageId) {
      return new Response('Missing messageId parameter', { status: 400 })
    }

    console.log(`📥 Fetching media for message ID: ${messageId}`)

    // Get media type from database
    const { data: message, error: dbError } = await supabase
      .from('message_log')
      .select('media_type')
      .eq('message_id', messageId)
      .single()

    if (dbError || !message) {
      console.error('❌ Message not found:', dbError)
      return new Response('Message not found', { status: 404 })
    }

    // Fetch media content from LINE
    const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: {
          'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
        }
      }
    )

    if (!response.ok) {
      console.error('❌ LINE API error:', await response.text())
      return new Response('Failed to fetch media from LINE', { status: response.status })
    }

    // Get content type from LINE response or default based on media_type
    let contentType = response.headers.get('content-type')
    
    if (!contentType) {
      // Fallback based on media_type from database
      switch (message.media_type) {
        case 'image':
          contentType = 'image/jpeg'
          break
        case 'audio':
          contentType = 'audio/mpeg'
          break
        case 'video':
          contentType = 'video/mp4'
          break
        default:
          contentType = 'application/octet-stream'
      }
    }

    // Get the media content
    const mediaContent = await response.arrayBuffer()

    console.log(`✅ Media fetched successfully (${contentType}, ${mediaContent.byteLength} bytes)`)

    // Return media with proper headers for mobile playback
    return new Response(mediaContent, {
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range'
      }
    })

  } catch (error) {
    console.error('❌ Error fetching media:', error)
    return new Response(`Error: ${error.message}`, { status: 500 })
  }
})