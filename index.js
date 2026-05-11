const express  = require('express');
const cors     = require('cors');
const midtrans = require('midtrans-client');
const admin    = require('firebase-admin'); // ← tambah ini
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Firebase Admin ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ── Midtrans clients ──────────────────────────────────────────────────────────
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


// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status   : 'Buket Backend Running ',
    serverKey: process.env.MIDTRANS_SERVER_KEY ? 'ada' : 'TIDAK ADA',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT UTAMA: Buat transaksi QRIS via Core API
// Response: { success, token, qr_string, qr_url }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/create-transaction', async (req, res) => {
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  const { orderId, amount, customerName, customerEmail, customerPhone, items } = req.body;

  if (!orderId || !amount) {
    return res.status(400).json({ success: false, message: 'orderId dan amount wajib' });
  }

  const grossAmount = parseInt(amount);

  // Buat item_details
  const itemDetails = (items || []).map(i => ({
    id      : String(i.productId   || 'ITEM'),
    price   : parseInt(i.price)    || 0,
    quantity: parseInt(i.quantity) || 1,
    name    : String(i.productName || 'Produk').substring(0, 50),
  }));

  // Sesuaikan total item dengan gross_amount
  const itemTotal = itemDetails.reduce((s, i) => s + i.price * i.quantity, 0);
  if (itemTotal !== grossAmount) {
    const diff = grossAmount - itemTotal;
    itemDetails.push({
      id      : 'ADJUSTMENT',
      price   : diff,
      quantity: 1,
      name    : diff > 0 ? 'Ongkir & Biaya Lain' : 'Diskon',
    });
  }

  // ── Coba Core API dulu (bisa dapat qr_string) ──────────────────────────────
  try {
    const coreParam = {
      payment_type      : 'qris',
      transaction_details: { order_id: orderId, gross_amount: grossAmount },
      customer_details  : {
        first_name: customerName  || 'Customer',
        email     : customerEmail || 'customer@email.com',
        phone     : customerPhone || '08000000000',
      },
      item_details: itemDetails,
      qris        : { acquirer: 'gopay' },
    };

    console.log('Core API param:', JSON.stringify(coreParam, null, 2));
    const coreResponse = await coreApi.charge(coreParam);
    console.log('Core API response:', JSON.stringify(coreResponse, null, 2));

    // Core API response untuk QRIS:
    // coreResponse.qr_string  → string EMVCo (ini yang dipakai simulator)
    // coreResponse.actions[0].url → URL QR image PNG

    const qrString = coreResponse.qr_string || null;
    const qrUrl    = coreResponse.actions?.find(a => a.name === 'generate-qr-code')?.url
                  || coreResponse.actions?.[0]?.url
                  || null;

    console.log('qr_string:', qrString ? qrString.substring(0, 30) + '...' : 'null');
    console.log('qr_url   :', qrUrl);

    // Juga generate Snap token (untuk fallback jika perlu)
    let snapToken = null;
    try {
      const snapParam = {
        transaction_details: { order_id: orderId + '-snap', gross_amount: grossAmount },
        customer_details   : { first_name: customerName || 'Customer', email: customerEmail },
        item_details       : itemDetails,
        enabled_payments   : ['qris'],
      };
      const snapTx = await snap.createTransaction(snapParam);
      snapToken    = snapTx.token;
    } catch (snapErr) {
      console.warn('Snap token gagal (tidak masalah):', snapErr.message);
    }

    return res.json({
      success  : true,
      token    : snapToken,       // untuk Midtrans SDK Flutter (startPaymentUiFlow)
      qr_string: qrString,        // untuk ditampilkan sebagai QR di Flutter
      qr_url   : qrUrl,           // URL gambar QR dari Midtrans
      order_id : coreResponse.transaction_id || orderId,
    });

  } catch (coreErr) {
    console.error(' Core API error:', coreErr.message, coreErr.ApiResponse);

    // ── Fallback: pakai Snap saja ───────────────────────────────────────────
    try {
      console.log('Fallback ke Snap...');
      const snapParam = {
        transaction_details: { order_id: orderId, gross_amount: grossAmount },
        customer_details   : {
          first_name: customerName  || 'Customer',
          email     : customerEmail || 'customer@email.com',
          phone     : customerPhone || '08000000000',
        },
        item_details   : itemDetails,
        enabled_payments: ['qris'],
        qris           : { acquirer: 'gopay' },
      };
      const snapTx = await snap.createTransaction(snapParam);
      console.log('Snap token:', snapTx.token);

      return res.json({
        success  : true,
        token    : snapTx.token,
        qr_string: null,
        qr_url   : null,
      });
    } catch (snapErr) {
      console.error(' Snap juga gagal:', snapErr.message);
      return res.status(500).json({
        success: false,
        message: snapErr.message,
        detail : snapErr.ApiResponse || coreErr.ApiResponse || null,
      });
    }
  }
});

// ── Buat Virtual Account (Bank Transfer) ──────────────────────────────────────
app.post('/create-va', async (req, res) => {
  console.log('VA Request:', JSON.stringify(req.body, null, 2));

  const { orderId, amount, customerName, customerEmail, customerPhone, items, bank } = req.body;

  if (!orderId || !amount || !bank) {
    return res.status(400).json({ success: false, message: 'orderId, amount, dan bank wajib' });
  }

  const grossAmount = parseInt(amount);

  const itemDetails = (items || []).map(i => ({
    id      : String(i.productId   || 'ITEM'),
    price   : parseInt(i.price)    || 0,
    quantity: parseInt(i.quantity) || 1,
    name    : String(i.productName || 'Produk').substring(0, 50),
  }));

  const itemTotal = itemDetails.reduce((s, i) => s + i.price * i.quantity, 0);
  if (itemTotal !== grossAmount) {
    const diff = grossAmount - itemTotal;
    itemDetails.push({
      id      : 'ADJUSTMENT',
      price   : diff,
      quantity: 1,
      name    : diff > 0 ? 'Ongkir & Biaya Lain' : 'Diskon',
    });
  }

  try {
    // Mandiri pakai echannel, lainnya pakai bank_transfer
    let chargeParam;

    if (bank === 'mandiri') {
      chargeParam = {
        payment_type       : 'echannel',
        transaction_details: { order_id: orderId, gross_amount: grossAmount },
        customer_details   : {
          first_name: customerName  || 'Customer',
          email     : customerEmail || 'customer@email.com',
          phone     : customerPhone || '08000000000',
        },
        item_details: itemDetails,
        echannel    : {
          bill_info1: 'Pembayaran',
          bill_info2: 'Buket Order',
        },
      };
    } else {
      chargeParam = {
        payment_type       : 'bank_transfer',
        transaction_details: { order_id: orderId, gross_amount: grossAmount },
        customer_details   : {
          first_name: customerName  || 'Customer',
          email     : customerEmail || 'customer@email.com',
          phone     : customerPhone || '08000000000',
        },
        item_details : itemDetails,
        bank_transfer: { bank: bank }, // 'bca' | 'bni' | 'bri' | 'permata' | 'bsi'
      };
    }

    console.log('VA charge param:', JSON.stringify(chargeParam, null, 2));
    const response = await coreApi.charge(chargeParam);
    console.log('VA response:', JSON.stringify(response, null, 2));

    // Ambil nomor VA dari response
    let vaNumber = null;

    if (bank === 'mandiri') {
      // Mandiri pakai bill_key + biller_code
      vaNumber = response.biller_code + response.bill_key;
    } else if (bank === 'bca') {
      vaNumber = response.va_numbers?.[0]?.va_number || null;
    } else {
      vaNumber = response.va_numbers?.[0]?.va_number
              || response.permata_va_number
              || null;
    }

    console.log('VA Number:', vaNumber);

    return res.json({
      success  : true,
      va_number: vaNumber,
      bank     : bank,
      order_id : orderId,
    });

  } catch (err) {
    console.error('VA error:', err.message, err.ApiResponse);
    return res.status(500).json({
      success: false,
      message: err.message,
      detail : err.ApiResponse || null,
    });
  }
});

// ── Simulate payment (sandbox only) ──────────────────────────────────────────
app.post('/simulate-payment/:orderId', async (req, res) => {
  try {
    // Panggil Midtrans simulator
    const response = await coreApi.transaction.status(req.params.orderId);
    console.log('Simulate status:', response.transaction_status);

    // Force settlement via Midtrans sandbox
    const axios = require('axios');
    await axios.post(
      `https://api.sandbox.midtrans.com/v2/${req.params.orderId}/accept`,
      {},
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(process.env.MIDTRANS_SERVER_KEY + ':').toString('base64'),
          'Content-Type': 'application/json',
        }
      }
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Simulate error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Cek status pembayaran ─────────────────────────────────────────────────────
app.get('/check-payment/:orderId', async (req, res) => {
  try {
    const status = await coreApi.transaction.status(req.params.orderId);
    console.log('Status:', req.params.orderId, '->', status.transaction_status);
    res.json({ success: true, data: status });
  } catch (e) {
    console.error('Check status error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Midtrans webhook notification ─────────────────────────────────────────────
app.post('/notification', async (req, res) => {
  try {
    const notification = await snap.transaction.notification(req.body);
    const { order_id, transaction_status, fraud_status } = notification;
    console.log(`Notif - ${order_id}: ${transaction_status} | fraud: ${fraud_status}`);

    // Tentukan status pembayaran
    let paymentStatus = 'pending';
    if (
      transaction_status === 'settlement' ||
      (transaction_status === 'capture' && fraud_status === 'accept')
    ) {
      paymentStatus = 'paid';
    } else if (['cancel', 'deny', 'expire'].includes(transaction_status)) {
      paymentStatus = 'failed';
    }

    // ← Update Firestore
    await db.collection('orders').doc(order_id).update({
      paymentStatus,
      paidAt: paymentStatus === 'paid' ? admin.firestore.FieldValue.serverTimestamp() : null,
    });

    console.log(`✅ Order ${order_id} updated → ${paymentStatus}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Notif error:', e.message);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});