import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// =============================================
// GOOGLE CALENDAR HELPER FUNCTIONS
// =============================================

async function getGoogleAccessToken() {
  const serviceAccount = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') || '{}');
  
  const jwtHeader = {
    alg: "RS256",
    typ: "JWT"
  };
  
  const now = Math.floor(Date.now() / 1000);
  const jwtClaim = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  
  // Create JWT (simplified - in production use a proper JWT library)
  const encoder = new TextEncoder();
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    str2ab(atob(serviceAccount.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, ''))),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
  
  const headerB64 = btoa(JSON.stringify(jwtHeader)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const claimB64 = btoa(JSON.stringify(jwtClaim)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsignedToken = `${headerB64}.${claimB64}`;
  
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(unsignedToken)
  );
  
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  
  const jwt = `${unsignedToken}.${signatureB64}`;
  
  // Exchange JWT for access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  
  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

function str2ab(str: string) {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

async function createCalendarEvent(eventDetails: any) {
  const accessToken = await getGoogleAccessToken();
  const calendarId = Deno.env.get('GOOGLE_CALENDAR_ID');
  
  const event = {
    summary: `Prokaiwa Lesson - ${eventDetails.studentName}`,
    description: `Video lesson with ${eventDetails.studentName}\n\nLesson Type: ${eventDetails.lessonType}\nDuration: ${eventDetails.duration} minutes`,
    start: {
      dateTime: eventDetails.startTime,
      timeZone: 'Asia/Tokyo'
    },
    end: {
      dateTime: eventDetails.endTime,
      timeZone: 'Asia/Tokyo'
    },
    conferenceData: {
      createRequest: {
        requestId: eventDetails.bookingId,
        conferenceSolutionKey: {
          type: 'hangoutsMeet'
        }
      }
    },
    attendees: [
      { email: eventDetails.studentEmail }
    ],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 }, // 24 hours before
        { method: 'popup', minutes: 60 } // 1 hour before
      ]
    }
  };
  
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    }
  );
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Calendar API error: ${error}`);
  }
  
  return await response.json();
}

async function updateCalendarEvent(eventId: string, updates: any) {
  const accessToken = await getGoogleAccessToken();
  const calendarId = Deno.env.get('GOOGLE_CALENDAR_ID');
  
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    }
  );
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Calendar API error: ${error}`);
  }
  
  return await response.json();
}

async function deleteCalendarEvent(eventId: string) {
  const accessToken = await getGoogleAccessToken();
  const calendarId = Deno.env.get('GOOGLE_CALENDAR_ID');
  
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    }
  );
  
  if (!response.ok && response.status !== 410) { // 410 = already deleted
    const error = await response.text();
    throw new Error(`Google Calendar API error: ${error}`);
  }
  
  return true;
}

// =============================================
// MAIN HANDLER
// =============================================

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { action, bookingData, eventId } = await req.json();

    switch (action) {
      case 'create':
        const calendarEvent = await createCalendarEvent(bookingData);
        return new Response(
          JSON.stringify({
            success: true,
            eventId: calendarEvent.id,
            meetLink: calendarEvent.hangoutLink
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

      case 'update':
        const updated = await updateCalendarEvent(eventId, bookingData);
        return new Response(
          JSON.stringify({
            success: true,
            event: updated
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

      case 'delete':
        await deleteCalendarEvent(eventId);
        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

      default:
        throw new Error('Invalid action');
    }

  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      }
    )
  }
})
