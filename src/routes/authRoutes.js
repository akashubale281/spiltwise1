const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { auth } = require('../middleware/auth');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/send-otp', authController.sendLoginOtp);
router.post('/verify-otp', authController.verifyLoginOtp);
router.get('/me', auth, authController.getMe);
router.put('/profile', auth, authController.updateProfile);
router.put('/change-password', auth, authController.changePassword);
router.post('/reset-password', authController.resetPassword);
router.delete('/account', auth, authController.deleteAccount);

// Multiple UPI IDs Management
router.get('/upi-ids', auth, authController.getUserUpiIds);
router.post('/upi-ids', auth, authController.addUserUpiId);
router.put('/upi-ids/:id/primary', auth, authController.setPrimaryUpiId);
router.delete('/upi-ids/:id', auth, authController.deleteUserUpiId);

module.exports = router;
