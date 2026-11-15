import type { DatabaseSync } from "node:sqlite";

/** Time-limited protection against late payments to ended, unpaid orders. */
export const UNPAID_AMOUNT_PROTECTION_MILLISECONDS = 24 * 60 * 60 * 1_000;

export function hasProtectedUnpaidAmountHistory(
  connection: DatabaseSync, slotId: string, paymentTime: number, includeCurrent = false,
): boolean {
  const multipleAccounts = connection.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'alipay_accounts'",
  ).get() !== undefined;
  return connection.prepare(`SELECT 1 FROM amount_slots AS current
    JOIN amount_slots AS previous
      ON previous.payable_amount_cents = current.payable_amount_cents
      AND previous.generation < current.generation + ?
      ${multipleAccounts ? "AND previous.alipay_account_id = current.alipay_account_id" : ""}
    JOIN payment_orders AS historical ON historical.order_id = previous.order_id
    WHERE current.slot_id = ? AND previous.released_at IS NOT NULL
      AND historical.payment_status = 'UNPAID'
      AND min(previous.released_at, historical.expires_at) + ? > ?
    LIMIT 1`).get(includeCurrent ? 1 : 0, slotId, UNPAID_AMOUNT_PROTECTION_MILLISECONDS, paymentTime) !== undefined;
}
