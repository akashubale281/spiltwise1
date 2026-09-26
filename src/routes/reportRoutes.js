const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { auth } = require('../middleware/auth');

router.get('/dashboard', auth, reportController.getDashboardAnalytics);
router.get('/export/csv', auth, reportController.exportExpensesCsv);
router.get('/backup', auth, reportController.backupUserData);
router.post('/restore', auth, reportController.restoreUserData);

module.exports = router;
