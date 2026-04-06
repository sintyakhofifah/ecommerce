const express    = require('express');
const cors       = require('cors');
const midtrans   = require('midtrans-client');
require('dotenv').config();

const app = express();

// ── CORS config — izinkan semua origin untuk Flutter ──────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
}));

app.use(express.json());

// ── Cek environment variables ─────────────────────────────────────────────
console.log('🔑 Server Key ada:', !!process.env.MIDTRANS_SERVER_KEY);
console.log('🔑 Client Key ada:', !!process.env.MIDTRANS_CLIENT_KEY);

if (!process.env.MIDTRANS_SERVER_KEY || !process.env.MIDTRANS_CLIENT_KEY) {
  console.error('❌ MIDTRANS_SERVER_KEY atau MIDTRANS_CLIENT_KEY tidak ada di .env!');
}

// ── Midtrans Snap client ───────────────────────────────────────────────────
const snap = new midtrans.Snap({
  isProduction: false, // sandbox mode — ganti true kalau sudah live
  serverKey   : process.env.MIDTRANS_SERVER_KEY,
  clientKey   : process.env.MIDTRANS_CLIENT_KEY,
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status    : 'Buket Backend Running ✅',
    timestamp : new Date().toISOString(),
    serverKey : process.env.MIDTRANS_SERVER_KEY ? 'ada ✅' : 'TIDAK ADA ❌',
    clientKey : process.env.MIDTRANS_CLIENT_KEY ? 'ada ✅' : 'TIDAK ADA ❌',
  });
});

// ── Generate Midtrans token ────────────────────────────────────────────────
app.post('/create-transaction', async (req, res) => {
  console.log('📦 Create transaction request:', JSON.stringify(req.body, null, 2));

  try {
    const {
      orderId,
      amount,
      customerName,
      customerEmail,
      customerPhone,
      items,
    } = req.body;

    // Validasi input
    if (!orderId || !amount || !customerName || !customerEmail) {
      return res.status(400).json({
        success: false,
        message: 'orderId, amount, customerName, customerEmail wajib diisi',
      });
    }

    // Pastikan amount adalah integer
    const grossAmount = parseInt(amount);
    if (isNaN(grossAmount) || grossAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'amount harus berupa angka positif',
      });
    }

    // Hitung total dari items untuk validasi
    const itemDetails = (items || []).map((i) => ({
      id      : i.productId   || 'ITEM',
      price   : parseInt(i.price) || 0,
      quantity: parseInt(i.quantity) || 1,
      name    : (i.productName || 'Produk').substring(0, 50), // max 50 char
    }));

    // Kalau item details ada, pastikan totalnya cocok
    // Kalau tidak cocok, tambahkan item adjustment
    const itemTotal = itemDetails.reduce(
      (sum, i) => sum + (i.price * i.quantity), 0
    );

    if (itemTotal !== grossAmount && itemDetails.length > 0) {
      const diff = grossAmount - itemTotal;
      if (diff !== 0) {
        itemDetails.push({
          id      : 'SHIPPING-DISCOUNT',
          price   : diff,
          quantity: 1,
          name    : diff > 0 ? 'Ongkir & Biaya Lain' : 'Diskon',
        });
      }
    }

    const parameter = {
      transaction_details: {
        order_id    : orderId,
        gross_amount: grossAmount,
      },
      customer_details: {
        first_name: customerName || 'Customer',
        email     : customerEmail,
        phone     : customerPhone || '08000000000',
      },
      item_details: itemDetails.length > 0 ? itemDetails : [{
        id      : 'ORDER',
        price   : grossAmount,
        quantity: 1,
        name    : 'Pembelian Buket',
      }],
      callbacks: {
        finish: 'myapp://payment-finish',
      },
    };

    console.log('📤 Midtrans parameter:', JSON.stringify(parameter, null, 2));

    const token = await snap.createTransactionToken(parameter);

    console.log('✅ Token berhasil dibuat:', token);
    res.json({ success: true, token });

  } catch (e) {
    console.error('❌ Midtrans error:', e.message);
    console.error('❌ Full error:', e);
    res.status(500).json({
      success: false,
      message: e.message,
      detail : e.ApiResponse || null,
    });
  }
});

// ── Cek status pembayaran ─────────────────────────────────────────────────
app.get('/check-payment/:orderId', async (req, res) => {
  try {
    const coreApi = new midtrans.CoreApi({
      isProduction: false,
      serverKey   : process.env.MIDTRANS_SERVER_KEY,
    });

    const status = await coreApi.transaction.status(req.params.orderId);
    console.log('💳 Payment status:', req.params.orderId, status.transaction_status);
    res.json({ success: true, data: status });
  } catch (e) {
    console.error('❌ Check payment error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Midtrans webhook notification ─────────────────────────────────────────
app.post('/notification', async (req, res) => {
  try {
    const notification = await snap.transaction.notification(req.body);
    const { order_id, transaction_status, fraud_status } = notification;

    console.log(`📦 Notification - Order ${order_id}: ${transaction_status} | Fraud: ${fraud_status}`);

    // Status mapping
    let orderStatus = 'pending';
    if (transaction_status === 'capture' || transaction_status === 'settlement') {
      if (fraud_status === 'accept' || !fraud_status) {
        orderStatus = 'paid';
      }
    } else if (transaction_status === 'cancel' || transaction_status === 'deny' ||
               transaction_status === 'expire') {
      orderStatus = 'cancelled';
    } else if (transaction_status === 'pending') {
      orderStatus = 'pending';
    }

    console.log(`✅ Order ${order_id} status: ${orderStatus}`);

    // TODO: Update Firestore dari sini kalau mau
    // Atau biarkan Flutter yang update via polling

    res.json({ success: true, orderStatus });
  } catch (e) {
    console.error('❌ Notification error:', e.message);
    res.status(500).json({ success: false });
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
});