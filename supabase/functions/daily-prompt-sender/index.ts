import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Send message via LINE Messaging API
async function sendLineMessage(lineId: string, message: string) {
  console.log(`Sending to LINE ID: ${lineId}`);
  
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
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('LINE API error:', error);
    return null;
  }
  
  return `line_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

Deno.serve(async (req) => {
  try {
    console.log('🚀 Starting daily prompt delivery...');

    // Get all active students with LINE plans
    const { data: responses, error: studentsError } = await supabase
      .from('questionnaire_responses')
      .select('user_id, line_id, level, goals, given_name_romaji, plan')
      .in('plan', ['A', 'C1', 'C2'])
      .not('line_id', 'is', null);

    if (studentsError) {
      console.error('Error fetching students:', studentsError);
      return new Response(JSON.stringify({ error: studentsError.message }), { status: 500 });
    }

    if (!responses || responses.length === 0) {
      console.log('No students to message today');
      return new Response(JSON.stringify({ message: 'No students found' }), { status: 200 });
    }

    // Get their progress records
    const userIds = responses.map(r => r.user_id);
    const { data: progressRecords, error: progressError } = await supabase
      .from('student_progress')
      .select('*')
      .in('user_id', userIds);

    if (progressError) {
      console.error('Error fetching progress:', progressError);
      return new Response(JSON.stringify({ error: progressError.message }), { status: 500 });
    }

    // Merge the data
    const studentsWithProgress = responses.map(student => {
      const progress = progressRecords?.find(p => p.user_id === student.user_id);
      return {
        ...student,
        student_progress: progress ? [progress] : []
      };
    }).filter(s => s.student_progress.length > 0);

    console.log(`Found ${studentsWithProgress.length} students with progress records`);
    const results = [];
    const today = new Date().toDateString();

    for (const student of studentsWithProgress) {
      const progress = student.student_progress[0];
      
      // Check if already sent today
      if (progress?.last_prompt_sent_at) {
        const lastSent = new Date(progress.last_prompt_sent_at).toDateString();
        if (lastSent === today) {
          console.log(`✓ Already sent to ${student.given_name_romaji} today`);
          continue;
        }
      }

      // Get purpose (defaults to Hobby if Other or missing)
      const purpose = student.goals?.purpose || 'Hobby';
      
      console.log(`Processing ${student.given_name_romaji}: Level=${student.level}, Purpose=${purpose}, Week=${progress.current_week}, Day=${progress.current_day}`);

      // Get today's prompt
      const { data: prompt, error: promptError } = await supabase
        .from('prompts')
        .select('*')
        .eq('level', student.level)
        .eq('purpose', purpose)
        .eq('week_number', progress.current_week)
        .eq('day_number', progress.current_day)
        .single();

      if (promptError || !prompt) {
        console.log(`❌ No prompt found for ${student.given_name_romaji}`);
        results.push({ student: student.given_name_romaji, status: 'no_prompt' });
        continue;
      }

      // Format the message
let message = `Good morning ${student.given_name_romaji}! ☀️

${prompt.prompt_text}

`;

// Add instructions for first-time users
if (progress.total_prompts_sent === 0) {
  message += `📱 How to respond:
- Send a voice message (recommended!)
- Or type your response
- Take your time - no rush!
- I'll review and send feedback within 24 hours

`;
}

message += `Take your time and reply whenever you're ready! 😊`;

      // Send via LINE
      const lineMessageId = await sendLineMessage(student.line_id, message);

      if (lineMessageId) {
        // Log the message
        await supabase.from('message_log').insert({
          user_id: student.user_id,
          prompt_id: prompt.id,
          message_type: 'prompt',
          message_text: message,
          line_message_id: lineMessageId
        });

        // Update student progress
        const nextDay = progress.current_day === 7 ? 1 : progress.current_day + 1;
        const nextWeek = progress.current_day === 7 ? progress.current_week + 1 : progress.current_week;

        await supabase
          .from('student_progress')
          .update({
            current_week: nextWeek,
            current_day: nextDay,
            last_prompt_sent_at: new Date().toISOString(),
            total_prompts_sent: (progress.total_prompts_sent || 0) + 1
          })
          .eq('user_id', student.user_id);

        results.push({ student: student.given_name_romaji, status: 'sent' });
        console.log(`✅ Sent prompt to ${student.given_name_romaji}`);
      } else {
        results.push({ student: student.given_name_romaji, status: 'failed' });
        console.log(`❌ Failed to send to ${student.given_name_romaji}`);
      }
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        results,
        total_sent: results.filter(r => r.status === 'sent').length,
        timestamp: new Date().toISOString()
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Fatal error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500 }
    );
  }
});