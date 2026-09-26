const express = require('express');
const router = express.Router();
const settlementController = require('../controllers/settlementController');
const { auth } = require('../middleware/auth');

router.post('/', auth, settlementController.createSettlement);
router.get('/group/:groupId', auth, settlementController.getGroupSettlements);
router.get('/user/history', auth, settlementController.getUserSettlements);
router.put('/:id/cancel', auth, settlementController.cancelSettlement);
router.get('/upi/details', auth, settlementController.getUpiDetails);
router.get('/upi/qr', auth, settlementController.getQuickQrCode);

module.exports = router;
