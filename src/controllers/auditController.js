const db = require('../config/db');

exports.getGroupAuditLogs = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.id;

    // Check membership
    const membership = await db.getAsync('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    if (!membership) return res.status(403).json({ success: false, message: 'Access denied.' });

    const logs = await db.allAsync(
      `SELECT a.*, u.name as user_name, u.photo_url
       FROM audit_logs a
       JOIN users u ON a.user_id = u.id
       WHERE a.group_id = ?
       ORDER BY a.created_at DESC
       LIMIT 50`,
      [groupId]
    );

    res.json({ success: true, logs });
  } catch (err) {
    console.error('Audit log error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve audit log.' });
  }
};
