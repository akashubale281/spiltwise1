const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { JWT_SECRET } = require('../middleware/auth');
const emailService = require('../services/emailService');

exports.register = async (req, res) => {
  try {
    const { name, email, password, upi_id, currency, monthly_budget } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
    }

    const existingUser = await db.getAsync('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.runAsync(
      `INSERT INTO users (name, email, password_hash, upi_id, currency, monthly_budget)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name.trim(), email.toLowerCase().trim(), passwordHash, upi_id ? upi_id.trim() : '', currency || 'INR', monthly_budget || 25000]
    );

    const user = await db.getAsync('SELECT id, name, email, upi_id, photo_url, currency, monthly_budget, created_at FROM users WHERE id = ?', [result.lastID]);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    // Send welcome notification
    await db.runAsync(
      'INSERT INTO notifications (user_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)',
      [user.id, 'Welcome to Splitwise Pro!', 'Account created successfully. Start by creating or joining a group.', 'info', '/dashboard']
    );

    res.status(201).json({
      success: true,
      message: 'Account registered successfully.',
      token,
      user
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const user = await db.getAsync('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const { password_hash, ...userProfile } = user;

    res.json({
      success: true,
      message: 'Logged in successfully.',
      token,
      user: userProfile
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
};

exports.sendLoginOtp = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email address is required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await db.getAsync('SELECT * FROM users WHERE email = ?', [normalizedEmail]);

    // If password was supplied, check credentials
    if (password) {
      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
      }
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
      }
    } else if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with this email. Please register first.' });
    }

    // Generate 6-digit OTP code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Clear previous OTPs for this email
    await db.runAsync('DELETE FROM login_otps WHERE email = ?', [normalizedEmail]);

    // Save active OTP
    await db.runAsync(
      'INSERT INTO login_otps (email, otp, attempts, expires_at) VALUES (?, ?, 0, ?)',
      [normalizedEmail, otp, expiresAt]
    );

    // Send email via emailService
    const emailResult = await emailService.sendLoginOtpEmail({
      email: normalizedEmail,
      name: user?.name,
      otp
    });

    res.json({
      success: true,
      message: `A 6-digit verification code has been sent to ${normalizedEmail}`,
      email: normalizedEmail,
      expiresIn: 600,
      deliveredReal: emailResult.deliveredReal,
      otpPreview: emailResult.otpPreview
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ success: false, message: 'Failed to send email verification code.' });
  }
};

exports.verifyLoginOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and verification code are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const cleanedOtp = otp.toString().trim();

    const record = await db.getAsync(
      'SELECT * FROM login_otps WHERE email = ? ORDER BY id DESC LIMIT 1',
      [normalizedEmail]
    );

    if (!record) {
      return res.status(400).json({ success: false, message: 'No active verification code found. Please request a new code.' });
    }

    if (Date.now() > record.expires_at) {
      await db.runAsync('DELETE FROM login_otps WHERE email = ?', [normalizedEmail]);
      return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new code.' });
    }

    if (record.attempts >= 5) {
      await db.runAsync('DELETE FROM login_otps WHERE email = ?', [normalizedEmail]);
      return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }

    if (record.otp !== cleanedOtp) {
      await db.runAsync('UPDATE login_otps SET attempts = attempts + 1 WHERE id = ?', [record.id]);
      const remaining = 4 - record.attempts;
      return res.status(400).json({ success: false, message: `Invalid code. ${remaining > 0 ? `${remaining} attempts remaining.` : 'Code revoked.'}` });
    }

    // OTP matched! Invalidate code
    await db.runAsync('DELETE FROM login_otps WHERE email = ?', [normalizedEmail]);

    const user = await db.getAsync('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const { password_hash, ...userProfile } = user;

    res.json({
      success: true,
      message: 'Email OTP verified successfully! Welcome back.',
      token,
      user: userProfile
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ success: false, message: 'Server error during OTP verification.' });
  }
};

exports.getMe = async (req, res) => {
  try {
    const upiIds = await db.allAsync(
      'SELECT id, upi_id, label, is_primary, created_at FROM user_upi_ids WHERE user_id = ? ORDER BY is_primary DESC, id ASC',
      [req.user.id]
    );
    res.json({
      success: true,
      user: {
        ...req.user,
        upi_ids: upiIds
      }
    });
  } catch (err) {
    res.json({ success: true, user: req.user });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const { name, upi_id, photo_url, currency, monthly_budget } = req.body;
    const userId = req.user.id;

    await db.runAsync(
      `UPDATE users
       SET name = COALESCE(?, name),
           upi_id = COALESCE(?, upi_id),
           photo_url = COALESCE(?, photo_url),
           currency = COALESCE(?, currency),
           monthly_budget = COALESCE(?, monthly_budget)
       WHERE id = ?`,
      [name, upi_id, photo_url, currency, monthly_budget, userId]
    );

    const updated = await db.getAsync('SELECT id, name, email, upi_id, photo_url, currency, monthly_budget, created_at FROM users WHERE id = ?', [userId]);
    res.json({ success: true, message: 'Profile updated successfully.', user: updated });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new password are required.' });
    }

    const user = await db.getAsync('SELECT password_hash FROM users WHERE id = ?', [userId]);
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password does not match.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.runAsync('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ success: false, message: 'Failed to change password.' });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email and new password are required.' });
    }

    const user = await db.getAsync('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with that email address.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.runAsync('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, user.id]);

    res.json({ success: true, message: 'Password reset successful. You can now login with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Failed to reset password.' });
  }
};

exports.deleteAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    await db.runAsync('DELETE FROM users WHERE id = ?', [userId]);
    res.json({ success: true, message: 'Account and associated data deleted.' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete account.' });
  }
};

// ==================== MULTI-UPI MANAGEMENT ====================

exports.getUserUpiIds = async (req, res) => {
  try {
    const userId = req.user.id;
    const upiIds = await db.allAsync(
      'SELECT id, upi_id, label, is_primary, created_at FROM user_upi_ids WHERE user_id = ? ORDER BY is_primary DESC, id ASC',
      [userId]
    );
    res.json({ success: true, upiIds });
  } catch (err) {
    console.error('getUserUpiIds error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch UPI accounts.' });
  }
};

exports.addUserUpiId = async (req, res) => {
  try {
    const userId = req.user.id;
    const { upi_id, label, is_primary } = req.body;

    if (!upi_id || !upi_id.includes('@')) {
      return res.status(400).json({ success: false, message: 'Please enter a valid UPI ID (e.g. name@bank or mobile@upi).' });
    }

    const cleanUpi = upi_id.toLowerCase().trim();
    const cleanLabel = (label || 'Personal Account').trim();

    // Check duplicate for this user
    const existing = await db.getAsync(
      'SELECT id FROM user_upi_ids WHERE user_id = ? AND upi_id = ?',
      [userId, cleanUpi]
    );
    if (existing) {
      return res.status(400).json({ success: false, message: 'This UPI ID is already linked to your account.' });
    }

    const currentCount = await db.getAsync('SELECT COUNT(*) as count FROM user_upi_ids WHERE user_id = ?', [userId]);
    const shouldBePrimary = is_primary || currentCount.count === 0 ? 1 : 0;

    if (shouldBePrimary === 1) {
      await db.runAsync('UPDATE user_upi_ids SET is_primary = 0 WHERE user_id = ?', [userId]);
      await db.runAsync('UPDATE users SET upi_id = ? WHERE id = ?', [cleanUpi, userId]);
    }

    const result = await db.runAsync(
      'INSERT INTO user_upi_ids (user_id, upi_id, label, is_primary) VALUES (?, ?, ?, ?)',
      [userId, cleanUpi, cleanLabel, shouldBePrimary]
    );

    const inserted = await db.getAsync('SELECT * FROM user_upi_ids WHERE id = ?', [result.lastID]);
    res.status(201).json({
      success: true,
      message: 'UPI account added successfully.',
      upiId: inserted
    });
  } catch (err) {
    console.error('addUserUpiId error:', err);
    res.status(500).json({ success: false, message: 'Failed to add UPI ID.' });
  }
};

exports.setPrimaryUpiId = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const target = await db.getAsync(
      'SELECT id, upi_id FROM user_upi_ids WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    if (!target) {
      return res.status(404).json({ success: false, message: 'UPI account not found.' });
    }

    // Reset all to 0, then set selected to 1
    await db.runAsync('UPDATE user_upi_ids SET is_primary = 0 WHERE user_id = ?', [userId]);
    await db.runAsync('UPDATE user_upi_ids SET is_primary = 1 WHERE id = ? AND user_id = ?', [id, userId]);
    await db.runAsync('UPDATE users SET upi_id = ? WHERE id = ?', [target.upi_id, userId]);

    res.json({
      success: true,
      message: `Set ${target.upi_id} as primary UPI account.`,
      primaryUpiId: target.upi_id
    });
  } catch (err) {
    console.error('setPrimaryUpiId error:', err);
    res.status(500).json({ success: false, message: 'Failed to update primary UPI account.' });
  }
};

exports.deleteUserUpiId = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const target = await db.getAsync(
      'SELECT id, upi_id, is_primary FROM user_upi_ids WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    if (!target) {
      return res.status(404).json({ success: false, message: 'UPI account not found.' });
    }

    await db.runAsync('DELETE FROM user_upi_ids WHERE id = ? AND user_id = ?', [id, userId]);

    // If it was primary, promote the next available UPI ID
    if (target.is_primary === 1) {
      const nextUpi = await db.getAsync(
        'SELECT id, upi_id FROM user_upi_ids WHERE user_id = ? ORDER BY id ASC LIMIT 1',
        [userId]
      );
      if (nextUpi) {
        await db.runAsync('UPDATE user_upi_ids SET is_primary = 1 WHERE id = ?', [nextUpi.id]);
        await db.runAsync('UPDATE users SET upi_id = ? WHERE id = ?', [nextUpi.upi_id, userId]);
      } else {
        await db.runAsync("UPDATE users SET upi_id = '' WHERE id = ?", [userId]);
      }
    }

    res.json({ success: true, message: 'UPI account deleted successfully.' });
  } catch (err) {
    console.error('deleteUserUpiId error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete UPI ID.' });
  }
};
