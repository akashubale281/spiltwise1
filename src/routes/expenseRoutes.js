const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');
const { auth } = require('../middleware/auth');

router.post('/', auth, expenseController.createExpense);
router.get('/', auth, expenseController.getAllUserExpenses);
router.get('/:id', auth, expenseController.getExpenseById);
router.put('/:id', auth, expenseController.updateExpense);
router.delete('/:id', auth, expenseController.deleteExpense);
router.post('/:id/comments', auth, expenseController.addComment);
router.post('/:id/reactions', auth, expenseController.toggleReaction);

module.exports = router;
