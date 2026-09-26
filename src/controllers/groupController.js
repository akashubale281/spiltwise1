const db = require('../config/db');
const { simplifyDebts } = require('../utils/debtSimplifier');

// Helper to generate unique invite code
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Compute group balances and debt simplification
async function computeGroupBalances(groupId) {
  // 1. Get all members
  const members = await db.allAsync(
    `SELECT u.id, u.name, u.email, u.photo_url, u.upi_id, gm.role
     FROM group_members gm
     JOIN users u ON gm.user_id = u.id
     WHERE gm.group_id = ?`,
    [groupId]
  );

  const memberMap = {};
  const netBalances = {};
  members.forEach((m) => {
    memberMap[m.id] = m;
    netBalances[m.id] = 0;
  });

  // 2. Sum amounts paid by each user
  const paidRows = await db.allAsync(
    `SELECT ep.user_id, SUM(ep.amount_paid) as total_paid
     FROM expense_payers ep
     JOIN expenses e ON ep.expense_id = e.id
     WHERE e.group_id = ?
     GROUP BY ep.user_id`,
    [groupId]
  );
  paidRows.forEach((row) => {
    if (netBalances[row.user_id] !== undefined) {
      netBalances[row.user_id] += Number(row.total_paid);
    }
  });

  // 3. Sum amounts owed by each user
  const splitRows = await db.allAsync(
    `SELECT es.user_id, SUM(es.computed_amount) as total_owed
     FROM expense_splits es
     JOIN expenses e ON es.expense_id = e.id
     WHERE e.group_id = ?
     GROUP BY es.user_id`,
    [groupId]
  );
  splitRows.forEach((row) => {
    if (netBalances[row.user_id] !== undefined) {
      netBalances[row.user_id] -= Number(row.total_owed);
    }
  });

  // 4. Factor in completed settlements
  // If A pays B: A has paid more (+), B has received more / owed less (-)
  const settlements = await db.allAsync(
    `SELECT payer_id, payee_id, amount
     FROM settlements
     WHERE group_id = ? AND status = 'completed'`,
    [groupId]
  );
  settlements.forEach((s) => {
    if (netBalances[s.payer_id] !== undefined) {
      netBalances[s.payer_id] += Number(s.amount);
    }
    if (netBalances[s.payee_id] !== undefined) {
      netBalances[s.payee_id] -= Number(s.amount);
    }
  });

  // Format balances array
  const balances = members.map((m) => ({
    user: m,
    netBalance: Math.round(netBalances[m.id] * 100) / 100
  }));

  // Run debt minimization algorithm
  const rawTransactions = simplifyDebts(netBalances);
  const simplifiedTransactions = rawTransactions.map((tx) => ({
    from: memberMap[tx.from] || { id: tx.from, name: 'Unknown' },
    to: memberMap[tx.to] || { id: tx.to, name: 'Unknown' },
    amount: tx.amount
  }));

  return { balances, simplifiedTransactions, netBalances };
}

exports.createGroup = async (req, res) => {
  try {
    const { name, category, description, photo_url } = req.body;
    const userId = req.user.id;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Group name is required.' });
    }

    let inviteCode = generateInviteCode();
    let existing = await db.getAsync('SELECT id FROM groups WHERE invite_code = ?', [inviteCode]);
    while (existing) {
      inviteCode = generateInviteCode();
      existing = await db.getAsync('SELECT id FROM groups WHERE invite_code = ?', [inviteCode]);
    }

    const result = await db.runAsync(
      `INSERT INTO groups (name, category, description, photo_url, invite_code, admin_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name.trim(), category || 'Trip', description || '', photo_url || '', inviteCode, userId]
    );

    const groupId = result.lastID;

    // Add creator as admin
    await db.runAsync(
      'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
      [groupId, userId, 'admin']
    );

    // Audit log
    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [groupId, userId, 'create_group', `Created group "${name}" with code ${inviteCode}`]
    );

    const group = await db.getAsync('SELECT * FROM groups WHERE id = ?', [groupId]);
    res.status(201).json({ success: true, message: 'Group created successfully.', group });
  } catch (err) {
    console.error('Create group error:', err);
    res.status(500).json({ success: false, message: 'Failed to create group.' });
  }
};

exports.getMyGroups = async (req, res) => {
  try {
    const userId = req.user.id;
    const groups = await db.allAsync(
      `SELECT g.*, gm.role,
              (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
              (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE group_id = g.id) as total_spending
       FROM groups g
       JOIN group_members gm ON g.id = gm.group_id
       WHERE gm.user_id = ? AND g.is_archived = 0
       ORDER BY g.created_at DESC`,
      [userId]
    );

    // Compute user net balance in each group
    const groupsWithBalances = await Promise.all(
      groups.map(async (grp) => {
        const { netBalances } = await computeGroupBalances(grp.id);
        return {
          ...grp,
          myBalance: netBalances[userId] || 0
        };
      })
    );

    res.json({ success: true, groups: groupsWithBalances });
  } catch (err) {
    console.error('Get my groups error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve groups.' });
  }
};

exports.getGroupById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check membership
    const membership = await db.getAsync(
      'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
      [id, userId]
    );
    if (!membership) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group.' });
    }

    const group = await db.getAsync('SELECT * FROM groups WHERE id = ?', [id]);
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found.' });
    }

    const members = await db.allAsync(
      `SELECT u.id, u.name, u.email, u.photo_url, u.upi_id, gm.role, gm.joined_at
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ?
       ORDER BY gm.role DESC, u.name ASC`,
      [id]
    );

    const expenses = await db.allAsync(
      `SELECT e.*, u.name as creator_name,
              (SELECT COUNT(*) FROM comments WHERE expense_id = e.id) as comment_count
       FROM expenses e
       JOIN users u ON e.created_by = u.id
       WHERE e.group_id = ?
       ORDER BY e.date DESC, e.created_at DESC`,
      [id]
    );

    // Attach payers and splits to each expense
    const detailedExpenses = await Promise.all(
      expenses.map(async (exp) => {
        const payers = await db.allAsync(
          `SELECT ep.*, u.name, u.photo_url FROM expense_payers ep
           JOIN users u ON ep.user_id = u.id
           WHERE ep.expense_id = ?`,
          [exp.id]
        );
        const splits = await db.allAsync(
          `SELECT es.*, u.name, u.photo_url FROM expense_splits es
           JOIN users u ON es.user_id = u.id
           WHERE es.expense_id = ?`,
          [exp.id]
        );
        const reactions = await db.allAsync(
          `SELECT r.*, u.name FROM reactions r
           JOIN users u ON r.user_id = u.id
           WHERE r.expense_id = ?`,
          [exp.id]
        );
        return { ...exp, payers, splits, reactions };
      })
    );

    const { balances, simplifiedTransactions, netBalances } = await computeGroupBalances(id);

    const totalSpending = detailedExpenses.reduce((acc, it) => acc + Number(it.amount), 0);

    res.json({
      success: true,
      group: {
        ...group,
        myRole: membership.role,
        myBalance: netBalances[userId] || 0,
        totalSpending,
        members,
        expenses: detailedExpenses,
        balances,
        simplifiedTransactions
      }
    });
  } catch (err) {
    console.error('Get group by id error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve group details.' });
  }
};

exports.joinGroupByCode = async (req, res) => {
  try {
    const { code } = req.body;
    const userId = req.user.id;

    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, message: 'Invite code is required.' });
    }

    const group = await db.getAsync('SELECT * FROM groups WHERE UPPER(invite_code) = ?', [code.trim().toUpperCase()]);
    if (!group) {
      return res.status(404).json({ success: false, message: 'Invalid invite code or group does not exist.' });
    }

    const existingMember = await db.getAsync(
      'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
      [group.id, userId]
    );
    if (existingMember) {
      return res.status(400).json({ success: false, message: 'You are already a member of this group.', groupId: group.id });
    }

    // Check maximum 20 members limit
    const countRow = await db.getAsync('SELECT COUNT(*) as count FROM group_members WHERE group_id = ?', [group.id]);
    if (countRow.count >= 20) {
      return res.status(400).json({ success: false, message: 'Group has reached maximum limit of 20 members.' });
    }

    await db.runAsync(
      'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
      [group.id, userId, 'member']
    );

    // Notify group admin
    await db.runAsync(
      'INSERT INTO notifications (user_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)',
      [group.admin_id, 'New Member Joined', `${req.user.name} joined ${group.name}.`, 'group', `/groups/${group.id}`]
    );

    // Audit log
    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [group.id, userId, 'join_group', `${req.user.name} joined via invite code.`]
    );

    res.json({ success: true, message: `Successfully joined ${group.name}!`, groupId: group.id });
  } catch (err) {
    console.error('Join group error:', err);
    res.status(500).json({ success: false, message: 'Failed to join group.' });
  }
};

exports.addMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    const currentUserId = req.user.id;

    const group = await db.getAsync('SELECT * FROM groups WHERE id = ?', [id]);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found.' });

    // Check if requester is admin
    const myMembership = await db.getAsync('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [id, currentUserId]);
    if (!myMembership || myMembership.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only group admins can add members directly.' });
    }

    // Check maximum 20 members
    const countRow = await db.getAsync('SELECT COUNT(*) as count FROM group_members WHERE group_id = ?', [id]);
    if (countRow.count >= 20) {
      return res.status(400).json({ success: false, message: 'Group has reached maximum limit of 20 members.' });
    }

    const userToAdd = await db.getAsync('SELECT id, name, email FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!userToAdd) {
      return res.status(404).json({ success: false, message: 'No registered user found with that email.' });
    }

    const alreadyIn = await db.getAsync('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [id, userToAdd.id]);
    if (alreadyIn) {
      return res.status(400).json({ success: false, message: 'User is already a member of this group.' });
    }

    await db.runAsync('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [id, userToAdd.id, 'member']);

    // Notification for added user
    await db.runAsync(
      'INSERT INTO notifications (user_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)',
      [userToAdd.id, 'Added to Group', `You were added to "${group.name}" by ${req.user.name}.`, 'group', `/groups/${id}`]
    );

    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [id, currentUserId, 'add_member', `Added ${userToAdd.name} (${userToAdd.email}) to group.`]
    );

    res.json({ success: true, message: `${userToAdd.name} added to group successfully.` });
  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({ success: false, message: 'Failed to add member.' });
  }
};

exports.removeMember = async (req, res) => {
  try {
    const { id, memberId } = req.params;
    const currentUserId = req.user.id;

    const myMembership = await db.getAsync('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [id, currentUserId]);
    if (!myMembership || myMembership.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins can remove members.' });
    }

    // Check member balance
    const { netBalances } = await computeGroupBalances(id);
    const balance = netBalances[memberId] || 0;
    if (Math.abs(balance) > 0.05) {
      return res.status(400).json({
        success: false,
        message: `Cannot remove member with unsettled balance (${balance > 0 ? '+' : ''}${balance}). Please settle up first.`
      });
    }

    await db.runAsync('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [id, memberId]);

    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [id, currentUserId, 'remove_member', `Removed user ID ${memberId} from group.`]
    );

    res.json({ success: true, message: 'Member removed from group.' });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ success: false, message: 'Failed to remove member.' });
  }
};

exports.leaveGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { netBalances } = await computeGroupBalances(id);
    const balance = netBalances[userId] || 0;
    if (Math.abs(balance) > 0.05) {
      return res.status(400).json({
        success: false,
        message: `You cannot leave a group with an active balance of ${balance > 0 ? '+' : ''}${balance}. Please settle all balances first.`
      });
    }

    const group = await db.getAsync('SELECT admin_id FROM groups WHERE id = ?', [id]);
    if (group && group.admin_id === userId) {
      // If admin is leaving, transfer to another member if exists
      const anotherMember = await db.getAsync(
        'SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ? LIMIT 1',
        [id, userId]
      );
      if (anotherMember) {
        await db.runAsync('UPDATE groups SET admin_id = ? WHERE id = ?', [anotherMember.user_id, id]);
        await db.runAsync('UPDATE group_members SET role = "admin" WHERE group_id = ? AND user_id = ?', [id, anotherMember.user_id]);
      }
    }

    await db.runAsync('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [id, userId]);

    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [id, userId, 'leave_group', `${req.user.name} left the group.`]
    );

    res.json({ success: true, message: 'You have left the group.' });
  } catch (err) {
    console.error('Leave group error:', err);
    res.status(500).json({ success: false, message: 'Failed to leave group.' });
  }
};

exports.transferAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { newAdminId } = req.body;
    const currentUserId = req.user.id;

    const group = await db.getAsync('SELECT admin_id FROM groups WHERE id = ?', [id]);
    if (!group || group.admin_id !== currentUserId) {
      return res.status(403).json({ success: false, message: 'Only the current group admin can transfer ownership.' });
    }

    const isMember = await db.getAsync('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [id, newAdminId]);
    if (!isMember) {
      return res.status(400).json({ success: false, message: 'Target user is not a member of this group.' });
    }

    await db.runAsync('UPDATE groups SET admin_id = ? WHERE id = ?', [newAdminId, id]);
    await db.runAsync('UPDATE group_members SET role = "admin" WHERE group_id = ? AND user_id = ?', [id, newAdminId]);
    await db.runAsync('UPDATE group_members SET role = "member" WHERE group_id = ? AND user_id = ?', [id, currentUserId]);

    await db.runAsync(
      'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
      [id, currentUserId, 'transfer_admin', `Transferred admin role to user ${newAdminId}.`]
    );

    res.json({ success: true, message: 'Admin role transferred successfully.' });
  } catch (err) {
    console.error('Transfer admin error:', err);
    res.status(500).json({ success: false, message: 'Failed to transfer admin role.' });
  }
};

exports.updateGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, description, photo_url } = req.body;
    const userId = req.user.id;

    const membership = await db.getAsync('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [id, userId]);
    if (!membership || membership.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins can modify group settings.' });
    }

    await db.runAsync(
      `UPDATE groups
       SET name = COALESCE(?, name),
           category = COALESCE(?, category),
           description = COALESCE(?, description),
           photo_url = COALESCE(?, photo_url)
       WHERE id = ?`,
      [name, category, description, photo_url, id]
    );

    res.json({ success: true, message: 'Group updated successfully.' });
  } catch (err) {
    console.error('Update group error:', err);
    res.status(500).json({ success: false, message: 'Failed to update group.' });
  }
};

exports.deleteOrArchiveGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.query; // 'archive' or 'delete'
    const userId = req.user.id;

    const group = await db.getAsync('SELECT admin_id FROM groups WHERE id = ?', [id]);
    if (!group || group.admin_id !== userId) {
      return res.status(403).json({ success: false, message: 'Only group admins can archive or delete this group.' });
    }

    if (action === 'archive') {
      await db.runAsync('UPDATE groups SET is_archived = 1 WHERE id = ?', [id]);
      res.json({ success: true, message: 'Group archived successfully.' });
    } else {
      await db.runAsync('DELETE FROM groups WHERE id = ?', [id]);
      res.json({ success: true, message: 'Group deleted permanently.' });
    }
  } catch (err) {
    console.error('Delete group error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete/archive group.' });
  }
};
