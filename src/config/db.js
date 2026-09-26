const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, '../../database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
  }
});

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON;');

// Helper promise wrappers for sqlite3
db.getAsync = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

db.allAsync = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
};

db.runAsync = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

// Initialize tables and demo seed
const initDb = async () => {
  try {
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        upi_id TEXT DEFAULT '',
        photo_url TEXT DEFAULT '',
        currency TEXT DEFAULT 'INR',
        monthly_budget REAL DEFAULT 25000,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS login_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        otp TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT DEFAULT 'Trip',
        description TEXT DEFAULT '',
        photo_url TEXT DEFAULT '',
        invite_code TEXT UNIQUE NOT NULL,
        admin_id INTEGER NOT NULL,
        is_archived INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        category TEXT DEFAULT 'General',
        date TEXT NOT NULL,
        notes TEXT DEFAULT '',
        receipt_url TEXT DEFAULT '',
        is_recurring INTEGER DEFAULT 0,
        recurrence_frequency TEXT DEFAULT 'none',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS expense_payers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        amount_paid REAL NOT NULL,
        FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS expense_splits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        split_type TEXT NOT NULL,
        split_value REAL NOT NULL,
        computed_amount REAL NOT NULL,
        FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        payer_id INTEGER NOT NULL,
        payee_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        notes TEXT DEFAULT '',
        payment_method TEXT DEFAULT 'UPI',
        proof_url TEXT DEFAULT '',
        status TEXT DEFAULT 'completed',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
        FOREIGN KEY (payer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (payee_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        group_id INTEGER DEFAULT NULL,
        title TEXT NOT NULL,
        invoice_number TEXT DEFAULT '',
        vendor_name TEXT DEFAULT '',
        date TEXT NOT NULL,
        subtotal REAL NOT NULL,
        tax_amount REAL DEFAULT 0,
        tip_amount REAL DEFAULT 0,
        total_amount REAL NOT NULL,
        items_json TEXT NOT NULL,
        notes TEXT DEFAULT '',
        receipt_url TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        emoji TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(expense_id, user_id, emoji),
        FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'info',
        link TEXT DEFAULT '',
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER DEFAULT NULL,
        user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        details TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS user_upi_ids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        upi_id TEXT NOT NULL,
        label TEXT DEFAULT 'Personal',
        is_primary INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Ensure upi_id column exists on expenses
    const expenseColumns = await db.allAsync('PRAGMA table_info(expenses)');
    if (!expenseColumns.some((c) => c.name === 'upi_id')) {
      await db.runAsync("ALTER TABLE expenses ADD COLUMN upi_id TEXT DEFAULT ''");
    }

    // Ensure upi_id column exists on bills
    const billColumns = await db.allAsync('PRAGMA table_info(bills)');
    if (!billColumns.some((c) => c.name === 'upi_id')) {
      await db.runAsync("ALTER TABLE bills ADD COLUMN upi_id TEXT DEFAULT ''");
    }

    // Auto-migrate existing user upi_id entries into user_upi_ids
    const usersWithUpi = await db.allAsync("SELECT id, upi_id FROM users WHERE upi_id IS NOT NULL AND upi_id != ''");
    for (const u of usersWithUpi) {
      const existing = await db.getAsync('SELECT COUNT(*) as count FROM user_upi_ids WHERE user_id = ? AND upi_id = ?', [u.id, u.upi_id]);
      if (existing.count === 0) {
        await db.runAsync(
          "INSERT INTO user_upi_ids (user_id, upi_id, label, is_primary) VALUES (?, ?, 'Primary Bank (SBI)', 1)",
          [u.id, u.upi_id]
        );
      }
    }

    // Add secondary sample UPI IDs for Alex (demo user) if only 1 exists
    const alexUser = await db.getAsync("SELECT id FROM users WHERE email = 'demo@splitwise.com'");
    if (alexUser) {
      const alexUpiCount = await db.getAsync('SELECT COUNT(*) as count FROM user_upi_ids WHERE user_id = ?', [alexUser.id]);
      if (alexUpiCount.count <= 1) {
        await db.runAsync(
          "INSERT INTO user_upi_ids (user_id, upi_id, label, is_primary) VALUES (?, 'alex@okhdfcbank', 'HDFC Bank (Secondary)', 0)",
          [alexUser.id]
        );
        await db.runAsync(
          "INSERT INTO user_upi_ids (user_id, upi_id, label, is_primary) VALUES (?, 'alex@paytm', 'Paytm UPI', 0)",
          [alexUser.id]
        );
      }
    }

    // Check if seed data exists
    const userCount = await db.getAsync('SELECT COUNT(*) as count FROM users');
    if (userCount.count === 0) {
      console.log('Seeding initial demo data...');
      const passwordHash = await bcrypt.hash('password123', 10);

      // Seed 4 demo users
      const u1 = await db.runAsync(
        'INSERT INTO users (name, email, password_hash, upi_id, currency, monthly_budget) VALUES (?, ?, ?, ?, ?, ?)',
        ['Alex Morgan (You)', 'demo@splitwise.com', passwordHash, 'alex@oksbi', 'INR', 30000]
      );
      const u2 = await db.runAsync(
        'INSERT INTO users (name, email, password_hash, upi_id, currency, monthly_budget) VALUES (?, ?, ?, ?, ?, ?)',
        ['Sam Wilson', 'sam@splitwise.com', passwordHash, 'sam@icici', 'INR', 25000]
      );
      const u3 = await db.runAsync(
        'INSERT INTO users (name, email, password_hash, upi_id, currency, monthly_budget) VALUES (?, ?, ?, ?, ?, ?)',
        ['Priya Sharma', 'priya@splitwise.com', passwordHash, 'priya@okhdfcbank', 'INR', 28000]
      );
      const u4 = await db.runAsync(
        'INSERT INTO users (name, email, password_hash, upi_id, currency, monthly_budget) VALUES (?, ?, ?, ?, ?, ?)',
        ['David Chen', 'david@splitwise.com', passwordHash, 'david@paytm', 'INR', 20000]
      );

      // Seed Groups
      const g1 = await db.runAsync(
        'INSERT INTO groups (name, category, description, invite_code, admin_id) VALUES (?, ?, ?, ?, ?)',
        ['Goa Beach Villa Trip', 'Trip', 'Weekend getaway in Candolim Goa with beach villa & dining', 'GOA2026', u1.lastID]
      );
      const g2 = await db.runAsync(
        'INSERT INTO groups (name, category, description, invite_code, admin_id) VALUES (?, ?, ?, ?, ?)',
        ['Flat 402 Roommates', 'Home', 'Monthly apartment expenses, groceries, WiFi and utilities', 'FLAT402', u1.lastID]
      );

      // Add members to Group 1
      for (const uid of [u1.lastID, u2.lastID, u3.lastID, u4.lastID]) {
        await db.runAsync(
          'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
          [g1.lastID, uid, uid === u1.lastID ? 'admin' : 'member']
        );
      }

      // Add members to Group 2
      for (const uid of [u1.lastID, u2.lastID, u3.lastID]) {
        await db.runAsync(
          'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
          [g2.lastID, uid, uid === u1.lastID ? 'admin' : 'member']
        );
      }

      // Seed Expenses for Goa Trip
      // Expense 1: Villa Booking - 12,000 paid by Alex, split equally among 4 (3000 each)
      const exp1 = await db.runAsync(
        `INSERT INTO expenses (group_id, created_by, description, amount, category, date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [g1.lastID, u1.lastID, 'Candolim Beach Villa 3-Nights Booking', 12000, 'Travel', '2026-08-25', 'Advance payment for booking']
      );
      await db.runAsync('INSERT INTO expense_payers (expense_id, user_id, amount_paid) VALUES (?, ?, ?)', [exp1.lastID, u1.lastID, 12000]);
      for (const uid of [u1.lastID, u2.lastID, u3.lastID, u4.lastID]) {
        await db.runAsync(
          'INSERT INTO expense_splits (expense_id, user_id, split_type, split_value, computed_amount) VALUES (?, ?, ?, ?, ?)',
          [exp1.lastID, uid, 'equal', 25, 3000]
        );
      }

      // Expense 2: Seafood Dinner - 4,800 paid by Sam (4000) and Priya (800) [Multi-payer example!]
      const exp2 = await db.runAsync(
        `INSERT INTO expenses (group_id, created_by, description, amount, category, date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [g1.lastID, u2.lastID, "Fisherman's Wharf Seafood Dinner", 4800, 'Food', '2026-08-26', 'Multiple payers: Sam paid 4000, Priya paid 800']
      );
      await db.runAsync('INSERT INTO expense_payers (expense_id, user_id, amount_paid) VALUES (?, ?, ?)', [exp2.lastID, u2.lastID, 4000]);
      await db.runAsync('INSERT INTO expense_payers (expense_id, user_id, amount_paid) VALUES (?, ?, ?)', [exp2.lastID, u3.lastID, 800]);
      for (const uid of [u1.lastID, u2.lastID, u3.lastID, u4.lastID]) {
        await db.runAsync(
          'INSERT INTO expense_splits (expense_id, user_id, split_type, split_value, computed_amount) VALUES (?, ?, ?, ?, ?)',
          [exp2.lastID, uid, 'equal', 25, 1200]
        );
      }

      // Expense 3: Car Rental - 3,200 paid by David, split by custom shares (Alex: 2, Sam: 2, Priya: 2, David: 2)
      const exp3 = await db.runAsync(
        `INSERT INTO expenses (group_id, created_by, description, amount, category, date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [g1.lastID, u4.lastID, 'Self-Drive SUV Rental & Fuel', 3200, 'Travel', '2026-08-27', 'Split equally among 4']
      );
      await db.runAsync('INSERT INTO expense_payers (expense_id, user_id, amount_paid) VALUES (?, ?, ?)', [exp3.lastID, u4.lastID, 3200]);
      for (const uid of [u1.lastID, u2.lastID, u3.lastID, u4.lastID]) {
        await db.runAsync(
          'INSERT INTO expense_splits (expense_id, user_id, split_type, split_value, computed_amount) VALUES (?, ?, ?, ?, ?)',
          [exp3.lastID, uid, 'equal', 25, 800]
        );
      }

      // Flat 402 recurring expenses
      const exp4 = await db.runAsync(
        `INSERT INTO expenses (group_id, created_by, description, amount, category, date, notes, is_recurring, recurrence_frequency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [g2.lastID, u1.lastID, 'High-Speed Fiber Internet & Wi-Fi', 1500, 'Utilities', '2026-08-01', 'Monthly bill 300 Mbps', 1, 'monthly']
      );
      await db.runAsync('INSERT INTO expense_payers (expense_id, user_id, amount_paid) VALUES (?, ?, ?)', [exp4.lastID, u1.lastID, 1500]);
      for (const uid of [u1.lastID, u2.lastID, u3.lastID]) {
        await db.runAsync(
          'INSERT INTO expense_splits (expense_id, user_id, split_type, split_value, computed_amount) VALUES (?, ?, ?, ?, ?)',
          [exp4.lastID, uid, 'equal', 33.33, 500]
        );
      }

      // Seed comments and reactions
      await db.runAsync('INSERT INTO comments (expense_id, user_id, message) VALUES (?, ?, ?)', [
        exp1.lastID,
        u2.lastID,
        'Awesome villa! Best location close to the beach.'
      ]);
      await db.runAsync('INSERT INTO comments (expense_id, user_id, message) VALUES (?, ?, ?)', [
        exp2.lastID,
        u1.lastID,
        'That grilled butter garlic prawn was top notch!'
      ]);
      await db.runAsync('INSERT INTO reactions (expense_id, user_id, emoji) VALUES (?, ?, ?)', [exp1.lastID, u1.lastID, '🔥']);
      await db.runAsync('INSERT INTO reactions (expense_id, user_id, emoji) VALUES (?, ?, ?)', [exp1.lastID, u2.lastID, '👍']);
      await db.runAsync('INSERT INTO reactions (expense_id, user_id, emoji) VALUES (?, ?, ?)', [exp2.lastID, u3.lastID, '❤️']);

      // Seed notification
      await db.runAsync(
        'INSERT INTO notifications (user_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)',
        [
          u1.lastID,
          'Welcome to Splitwise Calculator Pro!',
          'You are ready to calculate, split expenses, upload bills, and settle with UPI.',
          'info',
          '/dashboard'
        ]
      );

      // Seed audit log
      await db.runAsync(
        'INSERT INTO audit_logs (group_id, user_id, action, details) VALUES (?, ?, ?, ?)',
        [g1.lastID, u1.lastID, 'create_group', 'Created group "Goa Beach Villa Trip"']
      );

      // Seed sample manual bill
      const billItems = JSON.stringify([
        { name: 'Grilled Kingfish Sizzler', qty: 2, price: 650, total: 1300 },
        { name: 'Garlic Naan Basket', qty: 3, price: 120, total: 360 },
        { name: 'Fresh Lime Soda', qty: 4, price: 90, total: 360 },
        { name: 'Goan Prawn Curry with Rice', qty: 2, price: 580, total: 1160 }
      ]);
      await db.runAsync(
        `INSERT INTO bills (user_id, group_id, title, invoice_number, vendor_name, date, subtotal, tax_amount, tip_amount, total_amount, items_json, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [u1.lastID, g1.lastID, 'Beach Shack Lunch Invoice', 'INV-2026-089', 'Curlies Beach Shack', '2026-08-26', 3180, 159, 100, 3439, billItems, 'Lunch by the shore']
      );

      console.log('Demo data seeded successfully!');
    }
  } catch (err) {
    console.error('Error initializing database tables:', err);
  }
};

initDb();

module.exports = db;
