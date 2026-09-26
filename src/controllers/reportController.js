const db = require('../config/db');

exports.getDashboardAnalytics = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Total paid by user across all expenses
    const paidRow = await db.getAsync(
      `SELECT COALESCE(SUM(amount_paid), 0) as total_paid
       FROM expense_payers
       WHERE user_id = ?`,
      [userId]
    );
    const totalPaid = Number(paidRow.total_paid || 0);

    // 2. Total share owed by user across all expenses
    const splitRow = await db.getAsync(
      `SELECT COALESCE(SUM(computed_amount), 0) as total_share
       FROM expense_splits
       WHERE user_id = ?`,
      [userId]
    );
    const totalShare = Number(splitRow.total_share || 0);

    // 3. Settlements paid out by user (+)
    const settledPaidRow = await db.getAsync(
      `SELECT COALESCE(SUM(amount), 0) as total_settled_paid
       FROM settlements
       WHERE payer_id = ? AND status = 'completed'`,
      [userId]
    );
    const totalSettledPaid = Number(settledPaidRow.total_settled_paid || 0);

    // 4. Settlements received by user (-)
    const settledReceivedRow = await db.getAsync(
      `SELECT COALESCE(SUM(amount), 0) as total_settled_received
       FROM settlements
       WHERE payee_id = ? AND status = 'completed'`,
      [userId]
    );
    const totalSettledReceived = Number(settledReceivedRow.total_settled_received || 0);

    // Net balance calculation
    // You are owed = positive net balance; You owe = negative net balance
    const netBalance = (totalPaid + totalSettledPaid) - (totalShare + totalSettledReceived);
    const youAreOwed = netBalance > 0 ? netBalance : 0;
    const youOwe = netBalance < 0 ? Math.abs(netBalance) : 0;

    // 5. Category-wise spending for user's share
    const categorySpending = await db.allAsync(
      `SELECT e.category, SUM(es.computed_amount) as total_amount
       FROM expense_splits es
       JOIN expenses e ON es.expense_id = e.id
       WHERE es.user_id = ?
       GROUP BY e.category
       ORDER BY total_amount DESC`,
      [userId]
    );

    // 6. Monthly spending breakdown for user's share
    const monthlySpending = await db.allAsync(
      `SELECT strftime('%Y-%m', e.date) as month, SUM(es.computed_amount) as total_amount
       FROM expense_splits es
       JOIN expenses e ON es.expense_id = e.id
       WHERE es.user_id = ?
       GROUP BY month
       ORDER BY month ASC
       LIMIT 12`,
      [userId]
    );

    // 7. Recent 5 expenses
    const recentExpenses = await db.allAsync(
      `SELECT e.*, g.name as group_name, u.name as creator_name,
              (SELECT amount_paid FROM expense_payers WHERE expense_id = e.id AND user_id = ?) as my_paid,
              (SELECT computed_amount FROM expense_splits WHERE expense_id = e.id AND user_id = ?) as my_share
       FROM expenses e
       JOIN groups g ON e.group_id = g.id
       JOIN group_members gm ON g.id = gm.group_id
       JOIN users u ON e.created_by = u.id
       WHERE gm.user_id = ?
       ORDER BY e.date DESC, e.created_at DESC
       LIMIT 6`,
      [userId, userId, userId]
    );

    // 8. Monthly budget
    const user = await db.getAsync('SELECT monthly_budget, currency FROM users WHERE id = ?', [userId]);
    const budget = user ? user.monthly_budget : 25000;
    const currentMonth = new Date().toISOString().slice(0, 7);
    const currentMonthSpentRow = await db.getAsync(
      `SELECT COALESCE(SUM(es.computed_amount), 0) as spent
       FROM expense_splits es
       JOIN expenses e ON es.expense_id = e.id
       WHERE es.user_id = ? AND strftime('%Y-%m', e.date) = ?`,
      [userId, currentMonth]
    );
    const currentMonthSpent = Number(currentMonthSpentRow.spent || 0);

    res.json({
      success: true,
      analytics: {
        totalPaid,
        totalShare,
        netBalance: Math.round(netBalance * 100) / 100,
        youAreOwed: Math.round(youAreOwed * 100) / 100,
        youOwe: Math.round(youOwe * 100) / 100,
        monthlyBudget: budget,
        currentMonthSpent: Math.round(currentMonthSpent * 100) / 100,
        budgetPercentage: budget > 0 ? Math.min(100, Math.round((currentMonthSpent / budget) * 100)) : 0,
        categorySpending,
        monthlySpending,
        recentExpenses
      }
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve analytics.' });
  }
};

exports.exportExpensesCsv = async (req, res) => {
  try {
    const userId = req.user.id;
    const { groupId } = req.query;

    let query = `
      SELECT e.id, e.date, e.description, e.category, e.amount as total_expense_amount,
             g.name as group_name, u.name as created_by_name,
             es.computed_amount as your_share,
             COALESCE(ep.amount_paid, 0) as your_amount_paid,
             e.notes
      FROM expenses e
      JOIN groups g ON e.group_id = g.id
      JOIN users u ON e.created_by = u.id
      JOIN expense_splits es ON e.id = es.expense_id AND es.user_id = ?
      LEFT JOIN expense_payers ep ON e.id = ep.expense_id AND ep.user_id = ?
    `;
    const params = [userId, userId];

    if (groupId) {
      query += ' WHERE e.group_id = ?';
      params.push(groupId);
    }

    query += ' ORDER BY e.date DESC';

    const rows = await db.allAsync(query, params);

    // Build CSV
    const headers = ['ID', 'Date', 'Description', 'Category', 'Group', 'Created By', 'Total Expense', 'Your Share', 'You Paid', 'Notes'];
    const csvLines = [headers.join(',')];

    for (const r of rows) {
      const line = [
        r.id,
        r.date,
        `"${(r.description || '').replace(/"/g, '""')}"`,
        `"${(r.category || '').replace(/"/g, '""')}"`,
        `"${(r.group_name || '').replace(/"/g, '""')}"`,
        `"${(r.created_by_name || '').replace(/"/g, '""')}"`,
        r.total_expense_amount,
        r.your_share,
        r.your_amount_paid,
        `"${(r.notes || '').replace(/"/g, '""')}"`
      ];
      csvLines.push(line.join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=splitwise_expenses_${Date.now()}.csv`);
    res.send(csvLines.join('\n'));
  } catch (err) {
    console.error('CSV export error:', err);
    res.status(500).json({ success: false, message: 'Failed to export CSV.' });
  }
};

exports.backupUserData = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await db.getAsync('SELECT id, name, email, upi_id, currency, monthly_budget FROM users WHERE id = ?', [userId]);
    const groups = await db.allAsync(
      `SELECT g.* FROM groups g
       JOIN group_members gm ON g.id = gm.group_id
       WHERE gm.user_id = ?`,
      [userId]
    );
    const expenses = await db.allAsync(
      `SELECT e.* FROM expenses e
       JOIN group_members gm ON e.group_id = gm.group_id
       WHERE gm.user_id = ?`,
      [userId]
    );
    const settlements = await db.allAsync(
      `SELECT s.* FROM settlements s
       WHERE s.payer_id = ? OR s.payee_id = ?`,
      [userId, userId]
    );
    const bills = await db.allAsync('SELECT * FROM bills WHERE user_id = ?', [userId]);

    const backup = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      user,
      groups,
      expenses,
      settlements,
      bills
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=splitwise_backup_${Date.now()}.json`);
    res.json(backup);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ success: false, message: 'Failed to create backup.' });
  }
};

exports.restoreUserData = async (req, res) => {
  try {
    const { backupData } = req.body;
    if (!backupData || !backupData.user) {
      return res.status(400).json({ success: false, message: 'Invalid backup file payload.' });
    }

    const userId = req.user.id;

    // Restore user settings
    if (backupData.user.upi_id || backupData.user.monthly_budget) {
      await db.runAsync(
        'UPDATE users SET upi_id = COALESCE(?, upi_id), monthly_budget = COALESCE(?, monthly_budget) WHERE id = ?',
        [backupData.user.upi_id, backupData.user.monthly_budget, userId]
      );
    }

    res.json({ success: true, message: 'Backup preferences restored successfully.' });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ success: false, message: 'Failed to restore backup.' });
  }
};
