const express  = require('express');
const cors     = require('cors');
const midtrans = require('midtrans-client');
const admin    = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Firebase Admin ────────────────────────────────────────────────────────────
// admin.initializeApp({
//   credential: admin.credential.cert({
//     projectId: process.env.FIREBASE_PROJECT_ID,
//     clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
//     privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
//   }),
// });

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
    status   : 'Buket Backend Running',
    serverKey: process.env.MIDTRANS_SERVER_KEY ? 'ada' : 'TIDAK ADA',
  });
});

// ── Helper: build item_details ────────────────────────────────────────────────
function buildItemDetails(items, grossAmount) {
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
  return itemDetails;
}

// ── QRIS via Core API ─────────────────────────────────────────────────────────
app.post('/create-transaction', async (req, res) => {
  console.log('📥 QRIS Request:', JSON.stringify(req.body, null, 2));

  const { orderId, amount, customerName, customerEmail, customerPhone, items } = req.body;

  if (!orderId || !amount) {
    return res.status(400).json({ success: false, message: 'orderId dan amount wajib' });
  }

  const grossAmount = parseInt(amount);
  const itemDetails = buildItemDetails(items, grossAmount);

  try {
    const coreParam = {
      payment_type       : 'qris',
      transaction_details: { order_id: orderId, gross_amount: grossAmount },
      customer_details   : {
        first_name: customerName  || 'Customer',
        email     : customerEmail || 'customer@email.com',
        phone     : customerPhone || '08000000000',
      },
      item_details: itemDetails,
      qris        : { acquirer: 'gopay' },
    };

    console.log('Core API QRIS param:', JSON.stringify(coreParam, null, 2));
    const coreResponse = await coreApi.charge(coreParam);
    console.log('Core API QRIS response:', JSON.stringify(coreResponse, null, 2));

    const qrString = coreResponse.qr_string || null;
    const qrUrl    = coreResponse.actions?.find(a => a.name === 'generate-qr-code')?.url
                  || coreResponse.actions?.[0]?.url
                  || null;

    // Generate Snap token sebagai fallback
    let snapToken = null;
    try {
      const snapTx = await snap.createTransaction({
        transaction_details: { order_id: orderId + '-snap', gross_amount: grossAmount },
        customer_details   : { first_name: customerName || 'Customer', email: customerEmail },
        item_details       : itemDetails,
        enabled_payments   : ['qris'],
      });
      snapToken = snapTx.token;
    } catch (snapErr) {
      console.warn('Snap token gagal (tidak masalah):', snapErr.message);
    }

    return res.json({
      success  : true,
      token    : snapToken,
      qr_string: qrString,
      qr_url   : qrUrl,
      order_id : coreResponse.transaction_id || orderId,
    });

  } catch (coreErr) {
    console.error('Core API error:', coreErr.message);

    // Fallback ke Snap
    try {
      const snapTx = await snap.createTransaction({
        transaction_details: { order_id: orderId, gross_amount: grossAmount },
        customer_details   : {
          first_name: customerName  || 'Customer',
          email     : customerEmail || 'customer@email.com',
          phone     : customerPhone || '08000000000',
        },
        item_details    : itemDetails,
        enabled_payments: ['qris'],
        qris            : { acquirer: 'gopay' },
      });

      return res.json({
        success  : true,
        token    : snapTx.token,
        qr_string: null,
        qr_url   : null,
      });
    } catch (snapErr) {
      console.error('Snap juga gagal:', snapErr.message);
      return res.status(500).json({
        success: false,
        message: snapErr.message,
        detail : snapErr.ApiResponse || coreErr.ApiResponse || null,
      });
    }
  }
});

// ── Virtual Account (Bank Transfer) ──────────────────────────────────────────
app.post('/create-va', async (req, res) => {
  console.log('📥 VA Request:', JSON.stringify(req.body, null, 2));

  const { orderId, amount, customerName, customerEmail, customerPhone, items, bank } = req.body;

  if (!orderId || !amount || !bank) {
    return res.status(400).json({ success: false, message: 'orderId, amount, dan bank wajib' });
  }

  const grossAmount = parseInt(amount);
  const itemDetails = buildItemDetails(items, grossAmount);

  try {
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
        bank_transfer: { bank: bank },
      };
    }

    console.log('VA charge param:', JSON.stringify(chargeParam, null, 2));
    const response = await coreApi.charge(chargeParam);
    console.log('VA response:', JSON.stringify(response, null, 2));

    // Ambil nomor VA
    let vaNumber = null;
    if (bank === 'mandiri') {
      vaNumber = (response.biller_code || '') + (response.bill_key || '');
    } else if (bank === 'bca') {
      vaNumber = response.va_numbers?.[0]?.va_number || null;
    } else {
      vaNumber = response.va_numbers?.[0]?.va_number
              || response.permata_va_number
              || null;
    }

    console.log('✅ VA Number:', vaNumber);

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
    const axios = require('axios');
    await axios.post(
      `https://api.sandbox.midtrans.com/v2/${req.params.orderId}/accept`,
      {},
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            process.env.MIDTRANS_SERVER_KEY + ':'
          ).toString('base64'),
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('✅ Simulate payment success:', req.params.orderId);
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

    let paymentStatus = 'pending';
    if (
      transaction_status === 'settlement' ||
      (transaction_status === 'capture' && fraud_status === 'accept')
    ) {
      paymentStatus = 'paid';
    } else if (['cancel', 'deny', 'expire'].includes(transaction_status)) {
      paymentStatus = 'failed';
    }

    await db.collection('orders').doc(order_id).update({
      paymentStatus,
      paidAt: paymentStatus === 'paid'
          ? admin.firestore.FieldValue.serverTimestamp()
          : null,
    });

    console.log(`✅ Order ${order_id} updated → ${paymentStatus}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Notif error:', e.message);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));