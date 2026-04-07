const express = require('express');
const cors    = require('cors');
const midtrans = require('midtrans-client');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

const coreApi = new midtrans.CoreApi({
  isProduction: false,
  serverKey   : process.env.MIDTRANS_SERVER_KEY,
  clientKey   : process.env.MIDTRANS_CLIENT_KEY,
});

app.get('/', (req, res) => res.json({ status: 'Backend Running ✅' }));

// ── CREATE QRIS ─────────────────────────────────────────────
app.post('/create-transaction', async (req, res) => {
  try {
    const { orderId, amount, customerName, customerEmail, customerPhone, items } = req.body;

    if (!orderId || !amount) {
      return res.status(400).json({ success: false, message: 'orderId & amount wajib' });
    }

    const grossAmount = parseInt(amount);

    const itemDetails = (items || []).map(i => ({
      id      : String(i.productId || 'ITEM').substring(0, 50),
      price   : parseInt(i.price) || 0,
      quantity: parseInt(i.quantity) || 1,
      name    : String(i.productName || 'Produk').substring(0, 50),
    }));

    const itemTotal = itemDetails.reduce((s, i) => s + (i.price * i.quantity), 0);

    if (itemTotal !== grossAmount) {
      const diff = grossAmount - itemTotal;
      itemDetails.push({
        id      : 'ADJ',
        price   : diff,
        quantity: 1,
        name    : diff > 0 ? 'Ongkir' : 'Diskon',
      });
    }

    const parameter = {
      payment_type: 'qris',
      transaction_details: {
        order_id    : orderId,
        gross_amount: grossAmount,
      },
      customer_details: {
        first_name: customerName  || 'Customer',
        email     : customerEmail || 'test@gmail.com',
        phone     : customerPhone || '08000000000',
      },
      item_details: itemDetails,
      qris: { acquirer: 'gopay' },
    };

    const transaction = await coreApi.charge(parameter);

    // 🔥 AMBIL QR URL (INI YANG BENAR)
    const qrUrl = transaction.actions?.find(
      (a) => a.name === 'generate-qr-code'
    )?.url;

    res.json({
      success   : true,
      qrUrl     : qrUrl, // ✅ PENTING
      orderId   : transaction.order_id,
      expireTime: transaction.expiry_time,
    });

  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── CHECK STATUS ────────────────────────────────────────────
app.get('/check-status/:orderId', async (req, res) => {
  try {
    const status = await coreApi.transaction.status(req.params.orderId);

    res.json({
      success           : true,
      transactionStatus : status.transaction_status,
      orderId           : status.order_id,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── FAKE PAYMENT (UNTUK DEMO) ───────────────────────────────
app.post('/fake-payment/:orderId', async (req, res) => {
  const { orderId } = req.params;

  console.log(`FAKE PAYMENT: ${orderId}`);

  res.json({
    success: true,
    transactionStatus: 'settlement'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));