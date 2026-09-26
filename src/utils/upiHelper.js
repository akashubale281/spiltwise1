const QRCode = require('qrcode');

function generateUpiUri({ upiId, payeeName, amount, note = 'Settlement via Splitwise Calculator' }) {
  if (!upiId) return '';
  const cleanUpi = upiId.trim();
  const cleanName = encodeURIComponent(payeeName || 'User');
  const cleanNote = encodeURIComponent(note);
  const cleanAmount = Number(amount || 0).toFixed(2);

  return `upi://pay?pa=${cleanUpi}&pn=${cleanName}&am=${cleanAmount}&cu=INR&tn=${cleanNote}`;
}

async function generateUpiQrCode({ upiId, payeeName, amount, note }) {
  const uri = generateUpiUri({ upiId, payeeName, amount, note });
  if (!uri) return null;
  try {
    const qrDataUrl = await QRCode.toDataURL(uri, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
      color: {
        dark: '#1e293b',
        light: '#ffffff'
      }
    });
    return { uri, qrDataUrl };
  } catch (err) {
    console.error('QR code generation error:', err);
    return { uri, qrDataUrl: null };
  }
}

function generateWhatsAppReminderMessage({ debtorName, creditorName, amount, currency = '₹', groupName, upiId }) {
  const amountStr = `${currency}${amount}`;
  const upiInfo = upiId ? `\n\n💳 Pay directly via UPI: ${upiId}\nPay Link: upi://pay?pa=${upiId}&pn=${encodeURIComponent(creditorName)}&am=${amount}&cu=INR&tn=Splitwise+Settlement` : '';
  
  const text = `👋 Hi ${debtorName}!\n\nThis is a friendly reminder that you owe *${amountStr}* to *${creditorName}*${groupName ? ` in *${groupName}*` : ''}.${upiInfo}\n\nPlease settle up when convenient. Thanks! ✨`;
  
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

module.exports = {
  generateUpiUri,
  generateUpiQrCode,
  generateWhatsAppReminderMessage
};
