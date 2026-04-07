const express = require('express');
const cors    = require('cors');
const midtrans = require('midtrans-client');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

const snap = new midtrans.Snap({
  isProduction: false,
  serverKey   : process.env.MIDTRANS_SERVER_KEY,
  clientKey   : process.env.MIDTRANS_CLIENT_KEY,
});

const coreApi = new midtrans.CoreApi({
  isProduction: false,
  serverKey   : process.env.MIDTRANS_SERVER_KEY,
  clientKey   : process.env.MIDTRANS_CLIENT_KEY,
});

app.get('/', (req, res) => res.json({ status: 'Buket Backend Running ✅' }));

// ── Generate QRIS Dinamis ─────────────────────────────────────────────────
app.post('/create-transaction', async (req, res) => {
  try {
    const { orderId, amount, customerName, customerEmail, customerPhone, items } = req.body;

    if (!orderId || !amount) {
      return res.status(400).json({ success: false, message: 'orderId dan amount wajib' });
    }

    const grossAmount = parseInt(amount);

    // ✅ FIX: Hitung total item dulu, lalu buat adjustment kalau tidak sama
    const itemDetails = (items || []).map(i => ({
      id      : String(i.productId   || 'ITEM').substring(0, 50),
      price   : parseInt(i.price)    || 0,
      quantity: parseInt(i.quantity) || 1,
      name    : String(i.productName || 'Produk').substring(0, 50),
    }));

    const itemTotal = itemDetails.reduce((s, i) => s + (i.price * i.quantity), 0);

    // Adjustment untuk ongkir/diskon supaya total selalu match
    if (itemTotal !== grossAmount) {
      const diff = grossAmount - itemTotal;
      itemDetails.push({
        id      : 'ADJ',
        price   : diff,
        quantity: 1,
        name    : diff > 0 ? 'Ongkos Kirim' : 'Diskon',
      });
    }

    // Generate QRIS via Core API
    const parameter = {
      payment_type      : 'qris',
      transaction_details: {
        order_id    : orderId,
        gross_amount: grossAmount,
      },
      customer_details: {
        first_name: customerName  || 'Customer',
        email     : customerEmail || 'customer@email.com',
        phone     : customerPhone || '08000000000',
      },
      item_details: itemDetails,
      qris        : { acquirer: 'gopay' },
    };

    const transaction = await coreApi.charge(parameter);

    console.log('✅ QRIS transaction:', transaction.order_id);
    console.log('✅ QR String:', transaction.qr_string ? 'ada' : 'tidak ada');

    res.json({
      success   : true,
      qrString  : transaction.qr_string,
      orderId   : transaction.order_id,
      expireTime: transaction.expiry_time,
    });
  } catch (e) {
    console.error('❌ Error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Cek status transaksi ──────────────────────────────────────────────────
app.get('/check-status/:orderId', async (req, res) => {
  try {
    const status = await coreApi.transaction.status(req.params.orderId);
    console.log(`📊 Status ${req.params.orderId}: ${status.transaction_status}`);
    res.json({
      success           : true,
      transactionStatus : status.transaction_status,
      fraudStatus       : status.fraud_status,
      orderId           : status.order_id,
    });
  } catch (e) {
    console.error('❌ Check status error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Webhook Midtrans ──────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const notification = await coreApi.transaction.notification(req.body);
    const { order_id, transaction_status, fraud_status } = notification;

    console.log(`📦 Webhook - ${order_id}: ${transaction_status}`);

    res.json({ success: true, transaction_status });
  } catch (e) {
    console.error('❌ Webhook error:', e.message);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));