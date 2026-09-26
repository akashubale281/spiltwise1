const express = require('express');
const router = express.Router();
const groupController = require('../controllers/groupController');
const { auth } = require('../middleware/auth');

router.post('/', auth, groupController.createGroup);
router.get('/my', auth, groupController.getMyGroups);
router.get('/:id', auth, groupController.getGroupById);
router.post('/join', auth, groupController.joinGroupByCode);
router.post('/:id/members', auth, groupController.addMember);
router.delete('/:id/members/:memberId', auth, groupController.removeMember);
router.post('/:id/leave', auth, groupController.leaveGroup);
router.put('/:id/transfer-admin', auth, groupController.transferAdmin);
router.put('/:id', auth, groupController.updateGroup);
router.delete('/:id', auth, groupController.deleteOrArchiveGroup);

module.exports = router;
