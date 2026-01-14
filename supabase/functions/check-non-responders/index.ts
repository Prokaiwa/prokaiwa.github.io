import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Reminder messages
const REMINDERS = {
  day3: (name: string) => `Hi ${name}! Just checking in - did you see your English prompt? No pressure, but daily practice = better results! 😊`,
  day5: (name: string) => `Hey ${name}, you haven't practiced in 4 days! Consistency is the secret to fluency. Your progress is waiting! 🎯\n\nReply anytime to get back on track!`,
  day7: (name: string) => `Hi ${name}, we noticed you've been away for 6 days. Everything okay? We're here to help!\n\nReply 'PAUSE' if you need a break, or jump back in anytime! 🌟`
}

async function sendLineMessage(lineId: string, message: string) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      to: lineId,
      messages: [{ type: 'text', text: message }]
    })
  })

  if (!response.ok) {
    const error = await response.text()
    console.error('LINE API error:', error)
    return false
  }
  return true
}

function calculateDaysMissed(lastPromptDate: string): number {
  const now = new Date()
  const promptDate = new Date(lastPromptDate)
  const diffTime = Math.abs(now.getTime() - promptDate.getTime())
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))
  return diffDays
}

Deno.serve(async (req) => {
  try {
    console.log('🔍 Checking for non-responders...')

    // Get all active students with LINE IDs
    const { data: students, error: studentsError } = await supabase
      .from('questionnaire_responses')
      .select('id, user_id, given_name_romaji, name, line_id, plan')
      .not('line_id', 'is', null)
      .in('plan', ['A', 'C1', 'C2'])

    if (studentsError) throw studentsError

    console.log(`📊 Found ${students.length} active students`)

    let remindersDay3 = 0
    let remindersDay5 = 0
    let remindersDay7 = 0

    for (const student of students) {
      if (!student.user_id) continue

      // Get the last prompt sent to this student
      const { data: lastPrompt, error: promptError } = await supabase
        .from('message_log')
        .select('created_at, message_id')
        .eq('user_id', student.user_id)
        .eq('message_type', 'prompt')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (promptError || !lastPrompt) {
        console.log(`⚠️ No prompts found for ${student.given_name_romaji || student.name}`)
        continue
      }

      // Check if they responded after the last prompt
      const { data: response, error: responseError } = await supabase
        .from('message_log')
        .select('created_at')
        .eq('user_id', student.user_id)
        .eq('message_type', 'student_response')
        .gte('created_at', lastPrompt.created_at)
        .limit(1)
        .single()

      // If they responded, skip this student
      if (response) {
        console.log(`✅ ${student.given_name_romaji || student.name} has responded`)
        continue
      }

      // Calculate days missed
      const daysMissed = calculateDaysMissed(lastPrompt.created_at)
      console.log(`⏰ ${student.given_name_romaji || student.name} - ${daysMissed} days missed`)

      // Check if we already sent a reminder today
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)

      const { data: todayReminder } = await supabase
        .from('message_log')
        .select('id')
        .eq('user_id', student.user_id)
        .eq('message_type', 'reminder')
        .gte('created_at', todayStart.toISOString())
        .single()

      // Skip if already sent reminder today
      if (todayReminder) {
        console.log(`🔕 Already sent reminder today to ${student.given_name_romaji || student.name}`)
        continue
      }

      // Send appropriate reminder based on days missed
      let reminderMessage = null
      let reminderType = null

      if (daysMissed === 2) {
        // Day 3 reminder (missed 2 days)
        reminderMessage = REMINDERS.day3(student.given_name_romaji || student.name)
        reminderType = 'day3'
        remindersDay3++
      } else if (daysMissed === 4) {
        // Day 5 reminder (missed 4 days)
        reminderMessage = REMINDERS.day5(student.given_name_romaji || student.name)
        reminderType = 'day5'
        remindersDay5++
      } else if (daysMissed === 6) {
        // Day 7 reminder (missed 6 days)
        reminderMessage = REMINDERS.day7(student.given_name_romaji || student.name)
        reminderType = 'day7'
        remindersDay7++
      }

      // Send reminder if applicable
      if (reminderMessage) {
        const sent = await sendLineMessage(student.line_id, reminderMessage)

        if (sent) {
          // Log the reminder
          await supabase.from('message_log').insert({
            user_id: student.user_id,
            message_type: 'reminder',
            message_text: `${reminderType}: ${reminderMessage}`,
            line_message_id: `reminder_${reminderType}_${Date.now()}`
          })

          console.log(`📨 Sent ${reminderType} reminder to ${student.given_name_romaji || student.name}`)
        }
      }
    }

    const summary = {
      success: true,
      totalStudents: students.length,
      reminders: {
        day3: remindersDay3,
        day5: remindersDay5,
        day7: remindersDay7,
        total: remindersDay3 + remindersDay5 + remindersDay7
      }
    }

    console.log('✅ Reminder check complete:', summary)

    return new Response(
      JSON.stringify(summary),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Error checking non-responders:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})