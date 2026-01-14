import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// =============================================
// HELPER FUNCTIONS
// =============================================

function calculateEndTime(startTime: string, durationMinutes: number): string {
  const start = new Date(startTime);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return end.toISOString();
}

async function getAvailableCredits(supabase: any, studentId: number): Promise<number> {
  const { data, error } = await supabase
    .rpc('get_available_credits', { p_student_id: studentId });
  
  if (error) {
    console.error('Error getting credits:', error);
    return 0;
  }
  
  return data || 0;
}

async function checkFirstTimeEligibility(supabase: any, studentId: number): Promise<boolean> {
  const { data, error } = await supabase
    .rpc('is_eligible_for_consultation', { p_student_id: studentId });
  
  if (error) {
    console.error('Error checking consultation eligibility:', error);
    return false;
  }
  
  return data || false;
}

async function isSlotAvailable(supabase: any, scheduledAt: string, duration: number): Promise<boolean> {
  const endTime = calculateEndTime(scheduledAt, duration);
  
  // Check for overlapping bookings
  const { data: overlapping, error } = await supabase
    .from('lesson_bookings')
    .select('id')
    .eq('status', 'scheduled')
    .or(`scheduled_at.lte.${endTime},scheduled_at.gte.${scheduledAt}`)
    .limit(1);
  
  if (error) {
    console.error('Error checking slot availability:', error);
    return false;
  }
  
  return overlapping.length === 0;
}

async function sendConfirmationEmail(studentEmail: string, bookingDetails: any) {
  // TODO: Implement email sending (using SendGrid, Resend, or similar)
  console.log('Sending confirmation email to:', studentEmail);
  console.log('Booking details:', bookingDetails);
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
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    )

    const { action, bookingData } = await req.json();

    // =============================================
    // ACTION: CREATE BOOKING
    // =============================================
    
    if (action === 'create') {
      const {
        studentId,
        scheduledAt,
        lessonType, // 'standard', 'retention', 'first_time_free'
        duration = 50
      } = bookingData;

      // Get user session
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        throw new Error('Not authenticated');
      }

      // Get student data
      const { data: student, error: studentError } = await supabase
        .from('questionnaire_responses')
        .select('*')
        .eq('id', studentId)
        .single();

      if (studentError || !student) {
        throw new Error('Student not found');
      }

      // Check if slot is available
      const slotAvailable = await isSlotAvailable(supabase, scheduledAt, duration);
      if (!slotAvailable) {
        throw new Error('This time slot is no longer available');
      }

      // Determine pricing and source
      let price = 0;
      let bookingSource = '';

      if (lessonType === 'standard') {
        // Check if student has Pro/Lite credits
        const credits = await getAvailableCredits(supabase, studentId);
        
        if (student.plan === 'C1' || student.plan === 'C2') {
          if (credits > 0) {
            // Use included credit
            bookingSource = `included_${student.plan === 'C1' ? 'lite' : 'pro'}`;
            price = 0;
          } else {
            // Pay for lesson
            bookingSource = 'paid';
            price = 4000;
          }
        } else {
          // Plan A or no plan - always paid
          bookingSource = 'paid';
          price = 4000;
        }
      } else if (lessonType === 'retention') {
        bookingSource = 'retention';
        price = 0;
      } else if (lessonType === 'first_time_free') {
        // Check eligibility
        const eligible = await checkFirstTimeEligibility(supabase, studentId);
        if (!eligible) {
          throw new Error('Not eligible for first-time consultation');
        }
        bookingSource = 'first_time';
        price = 0;
      }

      // Create Google Calendar event
      const calendarResponse = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'create',
            bookingData: {
              bookingId: crypto.randomUUID(),
              studentName: student.given_name_romaji || student.name,
              studentEmail: student.email,
              lessonType: lessonType,
              duration: duration,
              startTime: scheduledAt,
              endTime: calculateEndTime(scheduledAt, duration)
            }
          })
        }
      );

      const calendarResult = await calendarResponse.json();
      if (!calendarResult.success) {
        throw new Error('Failed to create calendar event');
      }

      // Create booking in database
      const { data: booking, error: bookingError } = await supabase
        .from('lesson_bookings')
        .insert({
          student_id: studentId,
          user_id: user.id,
          lesson_type: lessonType,
          scheduled_at: scheduledAt,
          duration_minutes: duration,
          price: price,
          payment_status: price > 0 ? 'pending' : 'paid',
          booking_source: bookingSource,
          google_meet_link: calendarResult.meetLink,
          google_calendar_event_id: calendarResult.eventId,
          status: 'scheduled'
        })
        .select()
        .single();

      if (bookingError) {
        // Rollback: delete calendar event
        await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              action: 'delete',
              eventId: calendarResult.eventId
            })
          }
        );
        throw bookingError;
      }

      // If using credit, deduct it
      if (bookingSource.startsWith('included_')) {
        const { error: creditError } = await supabase.rpc('use_lesson_credit', {
          p_student_id: studentId
        });
        if (creditError) {
          console.error('Error deducting credit:', creditError);
        }
      }

      // If first-time consultation, mark as claimed
      if (lessonType === 'first_time_free') {
        await supabase
          .from('first_time_consultations')
          .update({
            claimed: true,
            claimed_at: new Date().toISOString(),
            booking_id: booking.id
          })
          .eq('student_id', studentId);
      }

      // Send confirmation email
      await sendConfirmationEmail(student.email, {
        ...booking,
        studentName: student.given_name_romaji || student.name
      });

      return new Response(
        JSON.stringify({
          success: true,
          booking: booking,
          message: price > 0 
            ? 'Booking created - please complete payment'
            : 'Booking confirmed!'
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      );
    }

    // =============================================
    // ACTION: CANCEL BOOKING
    // =============================================
    
    if (action === 'cancel') {
      const { bookingId, reason } = bookingData;

      // Get user session
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        throw new Error('Not authenticated');
      }

      // Get booking
      const { data: booking, error: bookingError } = await supabase
        .from('lesson_bookings')
        .select('*')
        .eq('id', bookingId)
        .eq('user_id', user.id)
        .single();

      if (bookingError || !booking) {
        throw new Error('Booking not found');
      }

      // Check cancellation policy (24 hours)
      const scheduledTime = new Date(booking.scheduled_at);
      const now = new Date();
      const hoursUntil = (scheduledTime.getTime() - now.getTime()) / (1000 * 60 * 60);

      let refundStatus = 'none';
      if (booking.payment_status === 'paid' && booking.price > 0 && hoursUntil >= 24) {
        refundStatus = 'pending'; // Will be processed manually
      }

      // Update booking
      const { error: updateError } = await supabase
        .from('lesson_bookings')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          cancelled_by: user.id,
          cancellation_reason: reason,
          refund_status: refundStatus
        })
        .eq('id', bookingId);

      if (updateError) throw updateError;

      // Delete Google Calendar event
      if (booking.google_calendar_event_id) {
        await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              action: 'delete',
              eventId: booking.google_calendar_event_id
            })
          }
        );
      }

      // Restore credit if applicable
      if (booking.booking_source.startsWith('included_') && hoursUntil >= 24) {
        await supabase.rpc('restore_lesson_credit', {
          p_student_id: booking.student_id
        });
      }

      return new Response(
        JSON.stringify({
          success: true,
          refund: refundStatus === 'pending' ? 
            'Refund will be processed within 3-5 business days' :
            hoursUntil < 24 ? 'No refund available (less than 24 hours notice)' : 'N/A',
          message: 'Booking cancelled successfully'
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      );
    }

    // =============================================
    // ACTION: GET AVAILABLE SLOTS
    // =============================================
    
    if (action === 'getAvailableSlots') {
      const { date } = bookingData;
      
      // Get day of week
      const dateObj = new Date(date);
      const dayOfWeek = dateObj.getDay();
      
      // Get teacher availability for this day
      const { data: availability, error: availError } = await supabase
        .from('teacher_availability')
        .select('*')
        .eq('day_of_week', dayOfWeek)
        .eq('is_available', true);
      
      if (availError || !availability || availability.length === 0) {
        return new Response(
          JSON.stringify({ success: true, slots: [] }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Generate time slots (50-min lessons)
      const slots = [];
      for (const avail of availability) {
        const startHour = parseInt(avail.start_time.split(':')[0]);
        const endHour = parseInt(avail.end_time.split(':')[0]);
        
        for (let hour = startHour; hour < endHour; hour++) {
          const slotTime = `${date}T${hour.toString().padStart(2, '0')}:00:00+09:00`;
          
          // Check if slot is available
          const available = await isSlotAvailable(supabase, slotTime, 50);
          
          if (available) {
            slots.push({
              time: slotTime,
              display: `${hour}:00`,
              available: true
            });
          }
        }
      }
      
      return new Response(
        JSON.stringify({ success: true, slots }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    throw new Error('Invalid action');

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
