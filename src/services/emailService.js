const nodemailer = require('nodemailer');

let transporter = null;

const initTransporter = () => {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
      console.log('✅ SMTP email transporter initialized for:', process.env.SMTP_HOST);
    } catch (err) {
      console.error('⚠️ Failed to initialize SMTP transporter:', err.message);
      transporter = null;
    }
  } else {
    console.log('ℹ️ SMTP credentials not configured. Using live in-app email preview delivery.');
  }
};

initTransporter();

/**
 * Send 6-digit Login OTP to user's email
 */
const sendLoginOtpEmail = async ({ email, name, otp }) => {
  const recipientName = name || email.split('@')[0];
  const subject = `Your SplitVerse AI Verification Code: ${otp}`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; color: #ffffff; margin: 0; padding: 20px; }
        .card { max-width: 480px; margin: 0 auto; background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 32px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        .logo { font-size: 20px; font-weight: 900; color: #06b6d4; text-align: center; margin-bottom: 24px; letter-spacing: 1px; }
        .title { font-size: 18px; font-weight: 700; margin-bottom: 12px; color: #f9fafb; text-align: center; }
        .text { font-size: 14px; line-height: 1.6; color: #9ca3af; text-align: center; margin-bottom: 24px; }
        .otp-box { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px; }
        .otp-code { font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #38bdf8; margin: 0; }
        .expiry { font-size: 12px; color: #f59e0b; margin-top: 8px; font-weight: 600; }
        .security-notice { font-size: 11px; color: #6b7280; text-align: center; border-top: 1px solid #1f2937; padding-top: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">⚡ SPLITVERSE AI</div>
        <div class="title">Sign In Verification Code</div>
        <div class="text">
          Hello <strong>${recipientName}</strong>,<br>
          Use the 6-digit verification code below to complete your login.
        </div>
        <div class="otp-box">
          <div class="otp-code">${otp}</div>
          <div class="expiry">⏱️ Valid for 10 minutes</div>
        </div>
        <div class="text" style="font-size: 12px; margin-bottom: 16px;">
          Do not share this code with anyone. SplitVerse AI administrators will never ask for your verification code.
        </div>
        <div class="security-notice">
          If you did not request this login code, you can safely ignore this email.
        </div>
      </div>
    </body>
    </html>
  `;

  let deliveredReal = false;
  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || `"SplitVerse AI Security" <${process.env.SMTP_USER}>`,
        to: email,
        subject,
        html: htmlContent,
        text: `Your SplitVerse AI login verification code is ${otp}. Valid for 10 minutes.`
      });
      deliveredReal = true;
      console.log(`[EMAIL SERVICE] Sent real OTP email to: ${email}`);
    } catch (err) {
      console.error(`[EMAIL SERVICE] Failed sending real email via SMTP to ${email}:`, err.message);
    }
  }

  console.log('====================================================');
  console.log(`[EMAIL OTP SENT] To: ${email}`);
  console.log(`[EMAIL OTP CODE] >>> ${otp} <<<`);
  console.log(`[EMAIL DELIVERY] Real SMTP: ${deliveredReal ? 'Sent' : 'Simulated (In-App Preview Active)'}`);
  console.log('====================================================');

  return {
    success: true,
    deliveredReal,
    email,
    otpPreview: otp
  };
};

module.exports = {
  sendLoginOtpEmail
};
