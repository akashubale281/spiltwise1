const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditController');
const { auth } = require('../middleware/auth');

router.get('/group/:groupId', auth, auditController.getGroupAuditLogs);

module.exports = router;
