import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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

    const { studentId, feedbackText, teacherId } = await req.json()

    // Get student's LINE ID
    const { data: student, error: studentError } = await supabase
      .from('questionnaire_responses')
      .select('line_id, given_name_romaji, name, user_id')
      .eq('id', studentId)
      .single()

    if (studentError || !student) {
      throw new Error('Student not found')
    }

    // Get student progress for prompt_day
    const { data: progress } = await supabase
      .from('student_progress')
      .select('current_day')
      .eq('user_id', student.user_id)
      .single()

    // Send message via LINE
    const lineResponse = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')}`
      },
      body: JSON.stringify({
        to: student.line_id,
        messages: [{
          type: 'text',
          text: `📝 Feedback from your teacher:\n\n${feedbackText}`
        }]
      })
    })

    if (!lineResponse.ok) {
      const error = await lineResponse.text()
      throw new Error(`LINE API error: ${error}`)
    }

    // Log feedback to database
    const { data: feedbackLog, error: insertError } = await supabase
      .from('feedback_log')
      .insert({
        student_id: studentId,
        teacher_id: teacherId,
        feedback_type: 'teacher-portal',
        prompt_day: progress?.current_day || null,
        feedback_text: feedbackText
      })
      .select()
      .single()

    if (insertError) {
      console.error('Database insert error:', insertError)
      throw new Error(`Failed to log feedback: ${insertError.message}`)
    }

    console.log('✅ Feedback logged to database:', feedbackLog)

    return new Response(
      JSON.stringify({ success: true, message: 'Feedback sent successfully' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})