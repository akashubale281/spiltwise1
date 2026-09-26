const express = require('express');
const router = express.Router();
const billController = require('../controllers/billController');
const { auth } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.post('/upload', auth, upload.single('receipt'), billController.uploadAndScanReceipt);
router.post('/manual', auth, billController.createManualBill);
router.get('/my', auth, billController.getMyBills);
router.get('/:id', auth, billController.getBillById);

module.exports = router;
