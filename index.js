const express    = require('express');
const cors       = require('cors');
const midtrans   = require('midtrans-client');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Midtrans Snap client
const snap = new midtrans.Snap({
  isProduction: false, // sandbox mode
  serverKey   : process.env.MIDTRANS_SERVER_KEY,
  clientKey   : process.env.MIDTRANS_CLIENT_KEY,
});

// ── Generate Midtrans token ──────────────────────────────────────────────────
app.post('/create-transaction', async (req, res) => {
  try {
    const {
      orderId,
      amount,
      customerName,
      customerEmail,
      customerPhone,
      items,
    } = req.body;

    const parameter = {
      transaction_details: {
        order_id    : orderId,
        gross_amount: amount,
      },
      customer_details: {
        first_name: customerName,
        email     : customerEmail,
        phone     : customerPhone,
      },
      item_details: items.map((i) => ({
        id      : i.productId,
        price   : i.price,
        quantity: i.quantity,
        name    : i.productName,
      })),
      callbacks: {
        finish: 'myapp://payment-finish',
      },
    };

    const token = await snap.createTransactionToken(parameter);
    res.json({ success: true, token });
  } catch (e) {
    console.error('Midtrans error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Cek status pembayaran ────────────────────────────────────────────────────
app.get('/check-payment/:orderId', async (req, res) => {
  try {
    const coreApi = new midtrans.CoreApi({
      isProduction: false,
      serverKey   : process.env.MIDTRANS_SERVER_KEY,
    });

    const status = await coreApi.transaction.status(req.params.orderId);
    res.json({ success: true, data: status });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Midtrans webhook notification ────────────────────────────────────────────
app.post('/notification', async (req, res) => {
  try {
    const notification = await snap.transaction.notification(req.body);
    const { order_id, transaction_status, fraud_status } = notification;

    console.log(`📦 Order ${order_id}: ${transaction_status}`);

    // Update status di sini kalau pakai database
    // Untuk Firebase, update dari Flutter saja

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.get('/', (req, res) => res.json({ status: 'Buket Backend Running ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));