const db = require('../config/db');
const { parseReceipt } = require('../utils/receiptParser');

exports.uploadAndScanReceipt = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a receipt image or document.' });
    }

    const filename = req.file.filename;
    const originalName = req.file.originalname;
    const receiptUrl = `/uploads/${filename}`;

    // Perform simulated/intelligent OCR extraction
    const parsedData = parseReceipt(filename, originalName);

    res.json({
      success: true,
      message: 'Receipt uploaded and scanned successfully!',
      receiptUrl,
      data: parsedData
    });
  } catch (err) {
    console.error('Upload receipt error:', err);
    res.status(500).json({ success: false, message: 'Failed to process receipt upload.' });
  }
};

exports.createManualBill = async (req, res) => {
  try {
    const {
      group_id,
      title,
      invoice_number,
      vendor_name,
      date,
      subtotal,
      tax_amount,
      tip_amount,
      total_amount,
      items, // array of { name, qty, price, total }
      notes,
      receipt_url,
      upi_id
    } = req.body;

    const userId = req.user.id;

    if (!title || !total_amount || !items || !Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Title, total amount, and item list are required.' });
    }

    const itemsJson = JSON.stringify(items);
    const result = await db.runAsync(
      `INSERT INTO bills (user_id, group_id, title, invoice_number, vendor_name, date, subtotal, tax_amount, tip_amount, total_amount, items_json, notes, receipt_url, upi_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        group_id || null,
        title.trim(),
        invoice_number || `INV-${Date.now().toString().slice(-6)}`,
        vendor_name || 'Generic Vendor',
        date || new Date().toISOString().split('T')[0],
        Number(subtotal || 0),
        Number(tax_amount || 0),
        Number(tip_amount || 0),
        Number(total_amount),
        itemsJson,
        notes || '',
        receipt_url || '',
        upi_id || ''
      ]
    );

    const bill = await db.getAsync('SELECT * FROM bills WHERE id = ?', [result.lastID]);
    bill.items = JSON.parse(bill.items_json);

    res.status(201).json({ success: true, message: 'Bill generated successfully.', bill });
  } catch (err) {
    console.error('Create bill error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate bill.' });
  }
};

exports.getMyBills = async (req, res) => {
  try {
    const userId = req.user.id;
    const bills = await db.allAsync(
      `SELECT b.*, g.name as group_name
       FROM bills b
       LEFT JOIN groups g ON b.group_id = g.id
       WHERE b.user_id = ?
       ORDER BY b.created_at DESC`,
      [userId]
    );

    const formatted = bills.map((b) => ({
      ...b,
      items: JSON.parse(b.items_json || '[]')
    }));

    res.json({ success: true, bills: formatted });
  } catch (err) {
    console.error('Get my bills error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve bills.' });
  }
};

exports.getBillById = async (req, res) => {
  try {
    const { id } = req.params;
    const bill = await db.getAsync(
      `SELECT b.*, u.name as creator_name, g.name as group_name
       FROM bills b
       JOIN users u ON b.user_id = u.id
       LEFT JOIN groups g ON b.group_id = g.id
       WHERE b.id = ?`,
      [id]
    );

    if (!bill) return res.status(404).json({ success: false, message: 'Bill not found.' });

    bill.items = JSON.parse(bill.items_json || '[]');
    res.json({ success: true, bill });
  } catch (err) {
    console.error('Get bill by id error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve bill.' });
  }
};
