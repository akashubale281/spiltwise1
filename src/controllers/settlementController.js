const db = require('../config/db');
const { generateUpiQrCode, generateUpiUri, generateWhatsAppReminderMessage } = require('../utils/upiHelper');

exports.createSettlement = async (req, res) => {
  try {
    const { group_id, payee_id, amount, payment_method, notes, proof_url } = req.body;
    const payer_id = req.user.id;

    if (!group_id || !payee_id || !amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Group, payee, and valid positive amount are required.' });
    }

    if (Number(payer_id) === Number(payee_id)) {
      return res.status(400).json({ success: false, message: 'You cannot settle up with yourself.' });
    }

    const group = await db.getAsync('SELECT name FROM groups WHERE id = ?', [group_id]);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found.' });

    const payee = await db.getAsync('SELECT name, email, upi_id FROM users WHERE id = ?', [payee_id]);
    if (!payee) return res.status(404).json({ success: false, message: 'Payee user not found.' });

    const result = await db.runAsync(
      `INSERT INTO settlements (group_id, payer_id, payee_id, amount, payment_method, notes, proof_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [group_id, payer_id, payee_id, Number(amount), payment_method || 'UPI', notes || '', proof_url || '', 'completed']
    );

    // Notify payee
    await db.runAsync(
      'INSERT INTO notifications (user_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)',
      [
        payee_id,
        'Settlement Received',
        `${req.user.name} recorded a settlement payment of ₹${Number(amount).toFixed(2)} via ${payment_method || 'UPI'} in ${group.name}.`,
        'settlement',
        `/groups/${group_id}`
      ]
    );

    // Audit log
    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [group_id, payer_id, 'settle', `Settled ₹${Number(amount).toFixed(2)} with ${payee.name} via ${payment_method || 'UPI'}.`]
    );

    res.status(201).json({ success: true, message: 'Settlement recorded successfully.', settlementId: result.lastID });
  } catch (err) {
    console.error('Create settlement error:', err);
    res.status(500).json({ success: false, message: 'Failed to record settlement.' });
  }
};

exports.getGroupSettlements = async (req, res) => {
  try {
    const { groupId } = req.params;
    const settlements = await db.allAsync(
      `SELECT s.*, u1.name as payer_name, u1.photo_url as payer_photo,
              u2.name as payee_name, u2.photo_url as payee_photo
       FROM settlements s
       JOIN users u1 ON s.payer_id = u1.id
       JOIN users u2 ON s.payee_id = u2.id
       WHERE s.group_id = ?
       ORDER BY s.created_at DESC`,
      [groupId]
    );

    res.json({ success: true, settlements });
  } catch (err) {
    console.error('Get group settlements error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve settlements.' });
  }
};

exports.getUserSettlements = async (req, res) => {
  try {
    const userId = req.user.id;
    const settlements = await db.allAsync(
      `SELECT s.*, g.name as group_name,
              u1.name as payer_name, u1.photo_url as payer_photo,
              u2.name as payee_name, u2.photo_url as payee_photo
       FROM settlements s
       JOIN groups g ON s.group_id = g.id
       JOIN users u1 ON s.payer_id = u1.id
       JOIN users u2 ON s.payee_id = u2.id
       WHERE s.payer_id = ? OR s.payee_id = ?
       ORDER BY s.created_at DESC`,
      [userId, userId]
    );

    res.json({ success: true, settlements });
  } catch (err) {
    console.error('Get user settlements error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve settlements.' });
  }
};

exports.cancelSettlement = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const settlement = await db.getAsync('SELECT * FROM settlements WHERE id = ?', [id]);
    if (!settlement) return res.status(404).json({ success: false, message: 'Settlement record not found.' });

    if (settlement.payer_id !== userId && settlement.payee_id !== userId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to cancel this settlement.' });
    }

    await db.runAsync('UPDATE settlements SET status = "cancelled" WHERE id = ?', [id]);

    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [settlement.group_id, userId, 'cancel_settlement', `Cancelled settlement of ₹${settlement.amount}.`]
    );

    res.json({ success: true, message: 'Settlement cancelled successfully.' });
  } catch (err) {
    console.error('Cancel settlement error:', err);
    res.status(500).json({ success: false, message: 'Failed to cancel settlement.' });
  }
};

exports.getUpiDetails = async (req, res) => {
  try {
    const { payeeId, amount, note, upiId: requestedUpiId } = req.query;
    const payee = await db.getAsync('SELECT id, name, upi_id FROM users WHERE id = ?', [payeeId]);

    if (!payee) return res.status(404).json({ success: false, message: 'Payee not found.' });

    // Fetch all active UPI accounts for this payee
    const payeeUpiAccounts = await db.allAsync(
      'SELECT id, upi_id, label, is_primary FROM user_upi_ids WHERE user_id = ? ORDER BY is_primary DESC, id ASC',
      [payeeId]
    );

    // Selected UPI ID is requestedUpiId, or primary from accounts, or payee.upi_id
    let upiId = requestedUpiId;
    if (!upiId) {
      const primaryAcc = payeeUpiAccounts.find((a) => a.is_primary === 1);
      upiId = primaryAcc ? primaryAcc.upi_id : (payee.upi_id || '');
    }

    const parsedAmount = Number(amount || 0);

    let qrCodeData = null;
    let upiUri = '';

    if (upiId) {
      const qrResult = await generateUpiQrCode({
        upiId,
        payeeName: payee.name,
        amount: parsedAmount,
        note: note || 'Settlement'
      });
      upiUri = qrResult.uri;
      qrCodeData = qrResult.qrDataUrl;
    }

    const whatsappLink = generateWhatsAppReminderMessage({
      debtorName: 'Friend',
      creditorName: payee.name,
      amount: parsedAmount,
      currency: '₹',
      upiId: upiId
    });

    res.json({
      success: true,
      payee: {
        id: payee.id,
        name: payee.name,
        upiId: upiId,
        primaryUpiId: payee.upi_id,
        upiAccounts: payeeUpiAccounts
      },
      amount: parsedAmount,
      upiUri,
      qrCodeData,
      whatsappLink
    });
  } catch (err) {
    console.error('Get UPI details error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate UPI details.' });
  }
};

exports.getQuickQrCode = async (req, res) => {
  try {
    const { upiId, payeeName, amount, note } = req.query;
    if (!upiId) return res.status(400).json({ success: false, message: 'UPI ID is required.' });

    const qrResult = await generateUpiQrCode({
      upiId,
      payeeName: payeeName || req.user.name,
      amount: Number(amount || 0),
      note: note || 'Splitwise Payment'
    });

    res.json({
      success: true,
      upiId,
      upiUri: qrResult ? qrResult.uri : '',
      qrCodeData: qrResult ? qrResult.qrDataUrl : null
    });
  } catch (err) {
    console.error('getQuickQrCode error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate QR code.' });
  }
};
