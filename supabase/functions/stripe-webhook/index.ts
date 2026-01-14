// supabase/functions/stripe-webhook/index.ts

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@12.17.0'

const stripe = new Stripe(Deno.env.get('STRIPE_API_KEY')!, {
  apiVersion: '2022-11-15',
  // Maintain a steady connection
  httpClient: Stripe.createFetchHttpClient(),
})

// The webhook signing secret, managed by Supabase secrets
const signingSecret = Deno.env.get('STRIPE_WEBHOOK_SIGNING_SECRET')!

Deno.serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature')
  const body = await req.text()

  let receivedEvent
  try {
    receivedEvent = await stripe.webhooks.constructEventAsync(body, signature!, signingSecret)
  } catch (err) {
    return new Response(err.message, { status: 400 })
  }

  // Handle the checkout.session.completed event
  if (receivedEvent.type === 'checkout.session.completed') {
    const session = receivedEvent.data.object
    const userId = session.client_reference_id

    if (!userId) {
      console.error('Webhook Error: Missing client_reference_id in session.')
      return new Response('Webhook Error: Missing user ID', { status: 400 })
    }

    // Create a Supabase client with the service_role key to bypass RLS
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('STRIPE_SERVICE_ROLE_KEY')! // <-- UPDATED SECRET NAME
    )

    // Update the user's payment status in the database
    const { error } = await supabaseAdmin
      .from('questionnaire_responses')
      .update({ payment_status: 'paid', updated_at: new Date() })
      .eq('user_id', userId)

    if (error) {
      console.error(`Supabase error for user ${userId}:`, error.message)
      return new Response(`Supabase error: ${error.message}`, { status: 500 })
    }

    console.log(`Successfully updated payment status for user: ${userId}`)
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})