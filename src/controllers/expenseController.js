const db = require('../config/db');

exports.createExpense = async (req, res) => {
  try {
    const {
      group_id,
      description,
      amount,
      category,
      date,
      notes,
      receipt_url,
      upi_id,
      is_recurring,
      recurrence_frequency,
      payers, // [{ userId, amountPaid }]
      splits  // [{ userId, splitType, splitValue, computedAmount }]
    } = req.body;

    const createdBy = req.user.id;

    if (!group_id || !description || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Group, description, and positive amount are required.' });
    }

    // Verify membership
    const membership = await db.getAsync(
      'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
      [group_id, createdBy]
    );
    if (!membership) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group.' });
    }

    // Verify payers sum matches total amount
    const parsedAmount = Number(amount);
    const validPayers = payers && payers.length > 0 ? payers : [{ userId: createdBy, amountPaid: parsedAmount }];
    const totalPaid = validPayers.reduce((acc, p) => acc + Number(p.amountPaid), 0);
    if (Math.abs(totalPaid - parsedAmount) > 0.05) {
      return res.status(400).json({
        success: false,
        message: `Sum of paid amounts (${totalPaid.toFixed(2)}) does not match total expense amount (${parsedAmount.toFixed(2)}).`
      });
    }

    // Verify splits sum matches total amount
    if (!splits || splits.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one member must be included in the split.' });
    }
    const totalSplit = splits.reduce((acc, s) => acc + Number(s.computedAmount), 0);
    if (Math.abs(totalSplit - parsedAmount) > 0.05) {
      return res.status(400).json({
        success: false,
        message: `Sum of split amounts (${totalSplit.toFixed(2)}) does not match total expense amount (${parsedAmount.toFixed(2)}).`
      });
    }

    // Insert expense
    const result = await db.runAsync(
      `INSERT INTO expenses (group_id, created_by, description, amount, category, date, notes, receipt_url, upi_id, is_recurring, recurrence_frequency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        group_id,
        createdBy,
        description.trim(),
        parsedAmount,
        category || 'General',
        date || new Date().toISOString().split('T')[0],
        notes || '',
        receipt_url || '',
        upi_id || '',
        is_recurring ? 1 : 0,
        recurrence_frequency || 'none'
      ]
    );

    const expenseId = result.lastID;

    // Insert payers
    for (const p of validPayers) {
      await db.runAsync(
        'INSERT INTO expense_payers (expense_id, user_id, amount_paid) VALUES (?, ?, ?)',
        [expenseId, p.userId, Number(p.amountPaid)]
      );
    }

    // Insert splits
    for (const s of splits) {
      await db.runAsync(
        `INSERT INTO expense_splits (expense_id, user_id, split_type, split_value, computed_amount)
         VALUES (?, ?, ?, ?, ?)`,
        [expenseId, s.userId, s.splitType || 'equal', Number(s.splitValue || 0), Number(s.computedAmount)]
      );

      // Create notification for other members involved
      if (s.userId !== createdBy) {
        await db.runAsync(
          'INSERT INTO notifications (user_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)',
          [
            s.userId,
            'New Expense Added',
            `${req.user.name} added "${description}" (₹${parsedAmount}) in your group. Your share is ₹${Number(s.computedAmount).toFixed(2)}.`,
            'expense',
            `/groups/${group_id}`
          ]
        );
      }
    }

    // Audit log
    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [group_id, createdBy, 'create_expense', `Added expense "${description}" for ₹${parsedAmount}.`]
    );

    res.status(201).json({ success: true, message: 'Expense added successfully.', expenseId });
  } catch (err) {
    console.error('Create expense error:', err);
    res.status(500).json({ success: false, message: 'Failed to create expense.' });
  }
};

exports.getExpenseById = async (req, res) => {
  try {
    const { id } = req.params;
    const expense = await db.getAsync(
      `SELECT e.*, u.name as creator_name, g.name as group_name
       FROM expenses e
       JOIN users u ON e.created_by = u.id
       JOIN groups g ON e.group_id = g.id
       WHERE e.id = ?`,
      [id]
    );

    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found.' });

    const payers = await db.allAsync(
      `SELECT ep.*, u.name, u.photo_url FROM expense_payers ep
       JOIN users u ON ep.user_id = u.id
       WHERE ep.expense_id = ?`,
      [id]
    );

    const splits = await db.allAsync(
      `SELECT es.*, u.name, u.photo_url FROM expense_splits es
       JOIN users u ON es.user_id = u.id
       WHERE es.expense_id = ?`,
      [id]
    );

    const comments = await db.allAsync(
      `SELECT c.*, u.name as user_name, u.photo_url
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.expense_id = ?
       ORDER BY c.created_at ASC`,
      [id]
    );

    const reactions = await db.allAsync(
      `SELECT r.*, u.name as user_name
       FROM reactions r
       JOIN users u ON r.user_id = u.id
       WHERE r.expense_id = ?`,
      [id]
    );

    res.json({
      success: true,
      expense: {
        ...expense,
        payers,
        splits,
        comments,
        reactions
      }
    });
  } catch (err) {
    console.error('Get expense by id error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve expense.' });
  }
};

exports.updateExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      description,
      amount,
      category,
      date,
      notes,
      receipt_url,
      upi_id,
      is_recurring,
      recurrence_frequency,
      payers,
      splits
    } = req.body;

    const userId = req.user.id;
    const oldExpense = await db.getAsync('SELECT * FROM expenses WHERE id = ?', [id]);
    if (!oldExpense) return res.status(404).json({ success: false, message: 'Expense not found.' });

    const parsedAmount = Number(amount);
    if (parsedAmount <= 0) return res.status(400).json({ success: false, message: 'Amount must be greater than 0.' });

    // Validate payers sum
    const validPayers = payers && payers.length > 0 ? payers : [{ userId, amountPaid: parsedAmount }];
    const totalPaid = validPayers.reduce((acc, p) => acc + Number(p.amountPaid), 0);
    if (Math.abs(totalPaid - parsedAmount) > 0.05) {
      return res.status(400).json({ success: false, message: 'Payer amounts must equal total expense amount.' });
    }

    // Validate splits sum
    const totalSplit = splits.reduce((acc, s) => acc + Number(s.computedAmount), 0);
    if (Math.abs(totalSplit - parsedAmount) > 0.05) {
      return res.status(400).json({ success: false, message: 'Split amounts must equal total expense amount.' });
    }

    await db.runAsync(
      `UPDATE expenses
       SET description = ?,
           amount = ?,
           category = ?,
           date = ?,
           notes = ?,
           receipt_url = ?,
           upi_id = ?,
           is_recurring = ?,
           recurrence_frequency = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        description.trim(),
        parsedAmount,
        category || 'General',
        date || oldExpense.date,
        notes || '',
        receipt_url !== undefined ? receipt_url : oldExpense.receipt_url,
        upi_id !== undefined ? upi_id : (oldExpense.upi_id || ''),
        is_recurring ? 1 : 0,
        recurrence_frequency || 'none',
        id
      ]
    );

    // Replace payers
    await db.runAsync('DELETE FROM expense_payers WHERE expense_id = ?', [id]);
    for (const p of validPayers) {
      await db.runAsync(
        'INSERT INTO expense_payers (expense_id, user_id, amount_paid) VALUES (?, ?, ?)',
        [id, p.userId, Number(p.amountPaid)]
      );
    }

    // Replace splits
    await db.runAsync('DELETE FROM expense_splits WHERE expense_id = ?', [id]);
    for (const s of splits) {
      await db.runAsync(
        `INSERT INTO expense_splits (expense_id, user_id, split_type, split_value, computed_amount)
         VALUES (?, ?, ?, ?, ?)`,
        [id, s.userId, s.splitType || 'equal', Number(s.splitValue || 0), Number(s.computedAmount)]
      );
    }

    // Audit log
    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [oldExpense.group_id, userId, 'edit_expense', `Edited expense "${oldExpense.description}" (Old: ₹${oldExpense.amount} -> New: ₹${parsedAmount}).`]
    );

    res.json({ success: true, message: 'Expense updated successfully.' });
  } catch (err) {
    console.error('Update expense error:', err);
    res.status(500).json({ success: false, message: 'Failed to update expense.' });
  }
};

exports.deleteExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const expense = await db.getAsync('SELECT * FROM expenses WHERE id = ?', [id]);
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found.' });

    // Track in audit log before deletion
    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [expense.group_id, userId, 'delete_expense', `Deleted expense "${expense.description}" of ₹${expense.amount}.`]
    );

    await db.runAsync('DELETE FROM expenses WHERE id = ?', [id]);

    res.json({ success: true, message: 'Expense deleted successfully.' });
  } catch (err) {
    console.error('Delete expense error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete expense.' });
  }
};

exports.getAllUserExpenses = async (req, res) => {
  try {
    const userId = req.user.id;
    const { search, category, startDate, endDate, minAmount, maxAmount, sortBy } = req.query;

    let query = `
      SELECT DISTINCT e.*, g.name as group_name, u.name as creator_name
      FROM expenses e
      JOIN groups g ON e.group_id = g.id
      JOIN group_members gm ON g.id = gm.group_id
      JOIN users u ON e.created_by = u.id
      WHERE gm.user_id = ?
    `;
    const params = [userId];

    if (search) {
      query += ' AND (e.description LIKE ? OR e.notes LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (category && category !== 'All') {
      query += ' AND e.category = ?';
      params.push(category);
    }

    if (startDate) {
      query += ' AND e.date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND e.date <= ?';
      params.push(endDate);
    }

    if (minAmount) {
      query += ' AND e.amount >= ?';
      params.push(Number(minAmount));
    }

    if (maxAmount) {
      query += ' AND e.amount <= ?';
      params.push(Number(maxAmount));
    }

    if (sortBy === 'oldest') {
      query += ' ORDER BY e.date ASC, e.created_at ASC';
    } else if (sortBy === 'highest') {
      query += ' ORDER BY e.amount DESC';
    } else if (sortBy === 'lowest') {
      query += ' ORDER BY e.amount ASC';
    } else {
      query += ' ORDER BY e.date DESC, e.created_at DESC';
    }

    const expenses = await db.allAsync(query, params);

    // Compute user's individual share and paid amount for each expense
    const enriched = await Promise.all(
      expenses.map(async (exp) => {
        const paidRow = await db.getAsync(
          'SELECT amount_paid FROM expense_payers WHERE expense_id = ? AND user_id = ?',
          [exp.id, userId]
        );
        const splitRow = await db.getAsync(
          'SELECT computed_amount FROM expense_splits WHERE expense_id = ? AND user_id = ?',
          [exp.id, userId]
        );

        return {
          ...exp,
          myPaid: paidRow ? paidRow.amount_paid : 0,
          myShare: splitRow ? splitRow.computed_amount : 0
        };
      })
    );

    res.json({ success: true, expenses: enriched });
  } catch (err) {
    console.error('Get all expenses error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve expenses.' });
  }
};

exports.addComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const userId = req.user.id;

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Comment text cannot be empty.' });
    }

    const result = await db.runAsync(
      'INSERT INTO comments (expense_id, user_id, message) VALUES (?, ?, ?)',
      [id, userId, message.trim()]
    );

    const newComment = await db.getAsync(
      `SELECT c.*, u.name as user_name, u.photo_url
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = ?`,
      [result.lastID]
    );

    res.status(201).json({ success: true, comment: newComment });
  } catch (err) {
    console.error('Add comment error:', err);
    res.status(500).json({ success: false, message: 'Failed to add comment.' });
  }
};

exports.toggleReaction = async (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    const userId = req.user.id;

    const existing = await db.getAsync(
      'SELECT id FROM reactions WHERE expense_id = ? AND user_id = ? AND emoji = ?',
      [id, userId, emoji]
    );

    if (existing) {
      await db.runAsync('DELETE FROM reactions WHERE id = ?', [existing.id]);
      res.json({ success: true, action: 'removed', emoji });
    } else {
      await db.runAsync(
        'INSERT INTO reactions (expense_id, user_id, emoji) VALUES (?, ?, ?)',
        [id, userId, emoji]
      );
      res.json({ success: true, action: 'added', emoji });
    }
  } catch (err) {
    console.error('Toggle reaction error:', err);
    res.status(500).json({ success: false, message: 'Failed to toggle reaction.' });
  }
};
