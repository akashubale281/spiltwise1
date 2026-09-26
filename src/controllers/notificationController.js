const db = require('../config/db');
const { generateWhatsAppReminderMessage } = require('../utils/upiHelper');

exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const notifications = await db.allAsync(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30',
      [userId]
    );
    const unreadCount = await db.getAsync(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    );

    res.json({ success: true, notifications, unreadCount: unreadCount.count });
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve notifications.' });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    await db.runAsync('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, userId]);
    res.json({ success: true, message: 'Notification marked as read.' });
  } catch (err) {
    console.error('Mark as read error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark notification as read.' });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    await db.runAsync('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (err) {
    console.error('Mark all as read error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark all as read.' });
  }
};

exports.sendPaymentReminder = async (req, res) => {
  try {
    const { debtorId, amount, groupName, customMessage } = req.body;
    const creditor = req.user;

    if (!debtorId || !amount) {
      return res.status(400).json({ success: false, message: 'Debtor ID and amount are required.' });
    }

    const debtor = await db.getAsync('SELECT id, name, email FROM users WHERE id = ?', [debtorId]);
    if (!debtor) return res.status(404).json({ success: false, message: 'Debtor not found.' });

    // Send in-app notification to debtor
    await db.runAsync(
      'INSERT INTO notifications (user_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)',
      [
        debtor.id,
        'Payment Reminder 🔔',
        customMessage || `Friendly reminder from ${creditor.name}: You owe ₹${Number(amount).toFixed(2)}${groupName ? ` in ${groupName}` : ''}. Please settle up when you can!`,
        'reminder',
        '/settlements'
      ]
    );

    // Generate WhatsApp reminder link
    const whatsappLink = generateWhatsAppReminderMessage({
      debtorName: debtor.name,
      creditorName: creditor.name,
      amount: Number(amount).toFixed(2),
      currency: '₹',
      groupName: groupName,
      upiId: creditor.upi_id
    });

    res.json({
      success: true,
      message: `Reminder sent to ${debtor.name}!`,
      whatsappLink
    });
  } catch (err) {
    console.error('Send payment reminder error:', err);
    res.status(500).json({ success: false, message: 'Failed to send payment reminder.' });
  }
};
