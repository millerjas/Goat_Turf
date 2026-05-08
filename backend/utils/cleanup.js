// ══════════════════════════════════════════════════════
//  Cleanup Utility
//  Deletes pending bookings older than 0 seconds
//  to prevent slot blocking by abandoned checkouts
// ══════════════════════════════════════════════════════
const supabase = require('../config/supabase');

async function cleanupPendingBookings() {
  try {
    // Calculate the cutoff time: 15 minutes ago
    // Gives users 15 minutes to complete their Razorpay checkout
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('bookings')
      .delete()
      .eq('payment_status', 'pending')
      .lt('created_at', cutoff)
      .select();

    if (error) {
      console.error('❌ Cleanup error:', error);
      return;
    }

    if (data && data.length > 0) {
      console.log(`🧹 Cleaned up ${data.length} stale pending booking(s):`);
      data.forEach((b) => {
        console.log(`   → ${b.sport} | ${b.booking_date} ${b.start_time}–${b.end_time} | Order: ${b.razorpay_order_id}`);
      });
    }
  } catch (err) {
    console.error('❌ Cleanup exception:', err);
  }
}

module.exports = { cleanupPendingBookings };
