/**
 * Debt Minimization / Debt Simplification Algorithm
 * 
 * Given a list of users and their net balances (totalPaid - totalOwed):
 * Net positive => Creditor (is owed money)
 * Net negative => Debtor (owes money)
 * Net zero     => Settled
 * 
 * This greedy algorithm reduces the number of transactions to the minimum possible (at most N-1 transactions).
 */

function simplifyDebts(netBalances) {
  // netBalances: { [userId]: number }
  const creditors = [];
  const debtors = [];

  for (const [userId, balance] of Object.entries(netBalances)) {
    const val = Math.round(balance * 100) / 100;
    if (val > 0.01) {
      creditors.push({ userId, amount: val });
    } else if (val < -0.01) {
      debtors.push({ userId, amount: Math.abs(val) });
    }
  }

  // Sort creditors descending, debtors descending
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transactions = [];

  let i = 0; // creditor index
  let j = 0; // debtor index

  while (i < creditors.length && j < debtors.length) {
    const creditor = creditors[i];
    const debtor = debtors[j];

    const settledAmount = Math.min(creditor.amount, debtor.amount);
    const rounded = Math.round(settledAmount * 100) / 100;

    if (rounded > 0) {
      transactions.push({
        from: debtor.userId,
        to: creditor.userId,
        amount: rounded
      });
    }

    creditor.amount = Math.round((creditor.amount - settledAmount) * 100) / 100;
    debtor.amount = Math.round((debtor.amount - settledAmount) * 100) / 100;

    if (creditor.amount <= 0.01) {
      i++;
    }
    if (debtor.amount <= 0.01) {
      j++;
    }
  }

  return transactions;
}

module.exports = { simplifyDebts };
