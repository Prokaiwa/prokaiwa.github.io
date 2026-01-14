import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Send message via LINE
async function sendLineMessage(userId: string, message: string) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: message }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('LINE API error:', error);
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  try {
    const body = await req.text();
    const data = JSON.parse(body);
    const events = data.events || [];

    console.log('📨 Webhook received:', JSON.stringify(events, null, 2));

    for (const event of events) {
      const userId = event.source?.userId;
      
      if (!userId) {
        console.log('⚠️ No userId in event');
        continue;
      }

      // ==============================================
      // HANDLE USER ACTIVATION (Follow/First Message)
      // ==============================================
      if (event.type === 'follow') {
        console.log(`🔔 Follow event from User ID: ${userId}`);

        // Check if this user is already registered
        const { data: existing } = await supabase
          .from('questionnaire_responses')
          .select('user_id, given_name_romaji')
          .eq('line_id', userId)
          .single();

        if (existing) {
          console.log(`✓ User ${existing.given_name_romaji} already registered`);
          continue;
        }

        // Find recent signup waiting for LINE activation
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        
        const { data: pendingUser, error: findError } = await supabase
          .from('questionnaire_responses')
          .select('user_id, given_name_romaji, email, plan')
          .is('line_id', null)
          .in('plan', ['A', 'C1', 'C2'])
          .gte('created_at', tenMinutesAgo)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (findError || !pendingUser) {
          console.log('❌ No recent pending signup found');
          
          await sendLineMessage(
            userId,
            'ご登録が見つかりませんでした。Prokaiwa.comで7日間無料トライアルをお申し込みください 😊\n\nRegistration not found. Please sign up for the 7-day free trial at Prokaiwa.com 😊'
          );
          continue;
        }

        console.log(`🎯 Matching ${pendingUser.given_name_romaji} with LINE User ID`);

        // Update their record with LINE User ID
        const { error: updateError } = await supabase
          .from('questionnaire_responses')
          .update({ line_id: userId })
          .eq('user_id', pendingUser.user_id);

        if (updateError) {
          console.error('❌ Failed to update:', updateError);
          continue;
        }

        // Log the activation
        await supabase.from('message_log').insert({
          user_id: pendingUser.user_id,
          message_type: 'webhook_activation',
          message_text: `LINE User ID captured: ${userId}`,
          line_message_id: `activation_${Date.now()}`
        });

        // Send welcome message
        const welcomeMessage = `Welcome ${pendingUser.given_name_romaji}! ✅

Your account is activated! Your first English conversation prompt will arrive tomorrow at 9 AM JST ☀️

Feel free to message me anytime with questions. Looking forward to helping you improve your English! 💪`;

        const sent = await sendLineMessage(userId, welcomeMessage);

        if (sent) {
          console.log(`✅ Successfully activated ${pendingUser.given_name_romaji}`);
        } else {
          console.log(`⚠️ Activated ${pendingUser.given_name_romaji} but welcome message failed`);
        }
      }

      // ==============================================
      // HANDLE STUDENT RESPONSES (Text/Audio/Video/Image)
      // ==============================================
      if (event.type === 'message') {
        console.log(`💬 Message event from User ID: ${userId}`);

        // Find the user by LINE ID
        const { data: student, error: studentError } = await supabase
          .from('questionnaire_responses')
          .select('user_id, given_name_romaji')
          .eq('line_id', userId)
          .single();

        if (studentError || !student) {
          console.log('⚠️ User not found in database, might be activation message');
          continue;
        }

        const messageType = event.message?.type;
        const messageId = event.message?.id;
        const messageText = event.message?.text || null;

        // Determine media type
        let mediaType = 'text';
        if (messageType === 'audio' || messageType === 'voice') {
          mediaType = 'audio';
        } else if (messageType === 'video') {
          mediaType = 'video';
        } else if (messageType === 'image') {
          mediaType = 'image';
        }

        console.log(`📝 Saving ${mediaType} response from ${student.given_name_romaji}`);

        // Save the student response to message_log
        const { error: insertError } = await supabase
          .from('message_log')
          .insert({
            user_id: student.user_id,
            message_type: 'student_response',
            message_text: messageText,
            message_id: messageId,
            media_type: mediaType,
            line_message_id: messageId
          });

        if (insertError) {
          console.error('❌ Failed to save response:', insertError);
        } else {
          console.log(`✅ Saved ${mediaType} response from ${student.given_name_romaji}`);
        }

        // Optional: Send auto-reply thanking them
        if (mediaType === 'audio' || mediaType === 'video') {
          await sendLineMessage(
            userId,
            '✅ Got it! Your teacher will review your response soon. Keep up the great work! 💪'
          );
        }
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('💥 Webhook error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500 }
    );
  }
});