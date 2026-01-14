import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get all teachers
    const { data: teachers } = await supabase
      .from('teachers')
      .select('id, email, full_name')
      .eq('is_active', true)

    for (const teacher of teachers || []) {
      // Get assigned students
      const { data: assignments } = await supabase
        .from('student_teacher_assignments')
        .select(`
          student_id,
          questionnaire_responses (
            id,
            user_id,
            given_name_romaji,
            name,
            plan
          )
        `)
        .eq('teacher_id', teacher.id)

      const students = assignments?.map(a => a.questionnaire_responses).filter(Boolean) || []

      // Get progress for all students
      const userIds = students.map(s => s.user_id).filter(Boolean)
      const { data: progressData } = await supabase
        .from('student_progress')
        .select('*')
        .in('user_id', userIds)

      // Categorize students needing feedback
      const planA: any[] = []
      const planC1: any[] = []
      const planC2: any[] = []

      for (const student of students) {
        const progress = progressData?.find(p => p.user_id === student.user_id)
        if (!progress) continue

        const needsFeedback = checkIfNeedsFeedback(student.plan, progress)
        
        if (needsFeedback) {
          const studentData = { ...student, ...progress }
          if (student.plan === 'A') planA.push(studentData)
          else if (student.plan === 'C1') planC1.push(studentData)
          else if (student.plan === 'C2') planC2.push(studentData)
        }
      }

      const totalStudents = planA.length + planC1.length + planC2.length

      if (totalStudents === 0) {
        console.log(`No students need feedback for ${teacher.full_name}`)
        continue
      }

      // Calculate estimated time
      const estimatedMinutes = (planA.length * 12) + (planC1.length * 5) + (planC2.length * 3)
      const hours = Math.floor(estimatedMinutes / 60)
      const minutes = estimatedMinutes % 60
      const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`

      // Log what would be sent (for now - actual email sending comes later)
      console.log(`📧 Would send email to ${teacher.email}:`)
      console.log(`   - ${totalStudents} students need feedback`)
      console.log(`   - Estimated time: ${timeStr}`)
      console.log(`   - Plan A: ${planA.length}, C1: ${planC1.length}, C2: ${planC2.length}`)
      
      // TODO: Implement actual email sending when ready
      // For now, this just logs what would be sent
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Daily email check completed',
        note: 'Email sending not yet implemented - check logs'
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

function checkIfNeedsFeedback(plan: string, progress: any): boolean {
  const { current_day, total_prompts_sent } = progress

  if (plan === 'A') {
    return total_prompts_sent % 7 === 0 && current_day === 7
  } else if (plan === 'C1') {
    return current_day === 3 || current_day === 7
  } else if (plan === 'C2') {
    return true
  }

  return false
}