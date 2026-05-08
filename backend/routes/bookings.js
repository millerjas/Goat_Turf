// ══════════════════════════════════════════════════════
//  Booking Routes
//  POST /check-slot
//  POST /create-booking
//  GET  /bookings?date=YYYY-MM-DD
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const razorpay = require('../config/razorpay');

// ── Pricing helper ─────────────────────────────────────
function calculatePrice(sport, startTime, endTime) {
  // Parse "HH:MM" to hours
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);

  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  const durationMinutes = endMinutes - startMinutes;

  if (durationMinutes <= 0) return null; // invalid

  const basePricePerHour = sport === 'football' 
    ? Number(process.env.PRICE_PER_HOUR_FOOTBALL) || 1000 
    : Number(process.env.PRICE_PER_HOUR_CRICKET) || 1000;

  let totalPrice = 0;
  for (let m = startMinutes; m < endMinutes; m++) {
    const h = Math.floor(m / 60);
    // 6 AM (6) to 6 PM (18): 50% discount
    if (h >= 6 && h < 18) {
      totalPrice += (basePricePerHour / 2) / 60;
    } else {
      totalPrice += basePricePerHour / 60;
    }
  }

  return Math.round(totalPrice);
}

// ── Overlap checker ────────────────────────────────────
// Returns true if the requested slot overlaps with any
// PAID booking on the given date.
async function hasOverlap(date, startTime, endTime, excludeId = null) {
  let query = supabase
    .from('bookings')
    .select('id, start_time, end_time, payment_status')
    .eq('booking_date', date)
    .eq('payment_status', 'paid')
    .lt('start_time', endTime)   // existing_start < new_end
    .gt('end_time', startTime);  // existing_end   > new_start

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('❌ Overlap check error:', error);
    throw error;
  }

  return data && data.length > 0;
}

// ─────────────────────────────────────────────────────
// 1️⃣  POST /check-slot
//     Check if the requested time slot is available
// ─────────────────────────────────────────────────────
router.post('/check-slot', async (req, res) => {
  try {
    const { date, start_time, end_time } = req.body;

    // Validate input
    if (!date || !start_time || !end_time) {
      return res.status(400).json({
        available: false,
        message: 'Missing required fields: date, start_time, end_time',
      });
    }

    // Validate that end_time > start_time
    if (end_time <= start_time) {
      return res.status(400).json({
        available: false,
        message: 'end_time must be after start_time',
      });
    }

    const overlap = await hasOverlap(date, start_time, end_time);

    if (overlap) {
      return res.json({
        available: false,
        message: 'Slot already booked for the requested time range',
      });
    }

    return res.json({ available: true });
  } catch (err) {
    console.error('❌ /check-slot error:', err);
    return res.status(500).json({
      available: false,
      message: 'Server error while checking slot',
    });
  }
});

// ─────────────────────────────────────────────────────
// 2️⃣  POST /create-booking
//     Creates a pending booking + Razorpay order
// ─────────────────────────────────────────────────────
router.post('/create-booking', async (req, res) => {
  try {
    const { sport, players, date, start_time, end_time, customer_name, phone } = req.body;

    // Validate input
    if (!sport || !players || !date || !start_time || !end_time) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: sport, players, date, start_time, end_time',
      });
    }

    if (!customer_name || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: customer_name, phone',
      });
    }

    if (!['cricket', 'football'].includes(sport)) {
      return res.status(400).json({
        success: false,
        message: 'Sport must be "cricket" or "football"',
      });
    }

    if (end_time <= start_time) {
      return res.status(400).json({
        success: false,
        message: 'end_time must be after start_time',
      });
    }

    // ── Step 1: Re-check slot availability (critical!) ──
    const overlap = await hasOverlap(date, start_time, end_time);
    if (overlap) {
      return res.status(409).json({
        success: false,
        message: 'Slot already booked. Please choose a different time.',
      });
    }

    // ── Step 2: Calculate price ──
    const price = calculatePrice(sport, start_time, end_time);
    if (!price || price <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid time range for price calculation',
      });
    }

    // ── Step 3: Create Razorpay order ──
    const razorpayOrder = await razorpay.orders.create({
      amount: price * 100, // Razorpay expects amount in paise
      currency: 'INR',
      receipt: `goat_${Date.now()}`,
      notes: {
        sport,
        players: String(players),
        date,
        start_time,
        end_time,
      },
    });

    // ── Step 4: Save booking in Supabase with status "pending" ──
    const { data: booking, error: insertError } = await supabase
      .from('bookings')
      .insert({
        sport,
        players: Number(players),
        booking_date: date,
        start_time,
        end_time,
        price,
        payment_status: 'pending',
        razorpay_order_id: razorpayOrder.id,
        customer_name: customer_name.trim(),
        phone: phone.trim(),
      })
      .select()
      .single();

    if (insertError) {
      console.error('❌ Supabase insert error:', insertError);
      return res.status(500).json({
        success: false,
        message: 'Failed to create booking in database',
      });
    }

    // ── Step 5: Return Razorpay order details to frontend ──
    return res.json({
      success: true,
      booking_id: booking.id,
      order: {
        id: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
      },
      price,
      razorpay_key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('❌ /create-booking error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error while creating booking',
    });
  }
});

// ─────────────────────────────────────────────────────
// 3️⃣  GET /bookings?date=YYYY-MM-DD
//     Returns all booked (paid + pending) slots for
//     a given date so frontend can disable them
// ─────────────────────────────────────────────────────
router.get('/bookings', async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'Missing required query parameter: date (YYYY-MM-DD)',
      });
    }

    const { data, error } = await supabase
      .from('bookings')
      .select('id, sport, players, booking_date, start_time, end_time, price, payment_status, created_at')
      .eq('booking_date', date)
      .eq('payment_status', 'paid')
      .order('start_time', { ascending: true });

    if (error) {
      console.error('❌ Supabase query error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch bookings',
      });
    }

    return res.json({
      success: true,
      date,
      bookings: data || [],
    });
  } catch (err) {
    console.error('❌ /bookings error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching bookings',
    });
  }
});

module.exports = router;
