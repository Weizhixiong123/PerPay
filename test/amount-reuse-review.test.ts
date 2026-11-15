import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "../src/database/database.ts";
import { AlipayAccountStore, AlipayAccountService } from "../src/alipay-accounts/index.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { OrderService } from "../src/orders/service.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";
import { recordLedgerEntry } from "./reconciliation-http-fixture.ts";
import { privatePem, platformPem } from "./application-key-fixture.ts";
import { UNPAID_AMOUNT_PROTECTION_MILLISECONDS } from "../src/orders/amount-reuse.ts";

const timestamp = (value: number) => new Date(value + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

for (const withinProtection of [true, false]) {
  it(`uses payment time rather than discovery time for the protection boundary (${withinProtection})`, async () => {
    const f = await createSitePaymentFixture();
    try {
      let site = f.createSite("Finite protection");
      site = f.sites.update(site.clientId, { revision: site.revision, configuration: { ...site.configuration,
        policy: { ...site.configuration.policy, orders: { ...site.configuration.policy.orders, amount_offset_maximum_cents: 1 } } } }, { actorId: "admin" });
      const orders = f.orders.forSite(site.clientId);
      const make = (name: string) => orders.create({ idempotency_key: name, merchant_order_no: name, amount_cents: 1000, product_name: name }).order;
      const old = make("old");
      // Align the deadline to the provider's whole-second timestamp precision.
      f.setNow(Math.ceil(f.now() / 1000) * 1000);
      orders.close(old.orderId);
      const deadline = f.now() + UNPAID_AMOUNT_PROTECTION_MILLISECONDS;
      f.setNow(deadline - 2_000);
      const current = make("current");
      assert.equal(current.payableAmountCents, old.payableAmountCents);
      const occurredAt = deadline - (withinProtection ? 1_000 : 0);
      f.setNow(deadline + 2_000);
      const entry = recordLedgerEntry(new LedgerStore(f.database), { start: timestamp(occurredAt - 60_000), end: timestamp(occurredAt + 60_000) },
        "boundary-payment", current.payableAmountCents, occurredAt, f.now(), "CREDIT", f.snapshot.activeProviderAccountKey!);
      f.setNow(f.now() + 10);
      const result = new ReconciliationStore(f.database).reconcileEntry(entry.ledgerEntryId, f.now());
      assert.equal(result.kind, withinProtection ? "ambiguous" : "auto_settled");
      assert.equal(orders.get(current.orderId).payment.status, withinProtection ? "UNPAID" : "CONFIRMED");
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
}

it("blocks reuse across websites and keeps the review after restarting", async () => {
  const f = await createSitePaymentFixture();
  try {
    const a = f.createSite("Old website"), b = f.createSite("New website");
    for (const site of [a, b]) f.sites.update(site.clientId, { revision: site.revision, configuration: { ...site.configuration, policy: { ...site.configuration.policy, orders: { ...site.configuration.policy.orders, amount_offset_maximum_cents: 1 } } } }, { actorId: "admin" });
    const old = f.orders.forSite(a.clientId).create({ idempotency_key: "old", merchant_order_no: "old", amount_cents: 1000, product_name: "Old order" }).order;
    f.orders.forSite(a.clientId).close(old.orderId);
    f.setNow(f.now() + 601_000);
    const current = f.orders.forSite(b.clientId).create({ idempotency_key: "current", merchant_order_no: "current", amount_cents: 1000, product_name: "New order" }).order;
    assert.equal(current.payableAmountCents, old.payableAmountCents);
    f.setNow(f.now() + 2_000);
    const entry = recordLedgerEntry(new LedgerStore(f.database), { start: timestamp(f.now() - 60_000), end: timestamp(f.now() + 60_000) },
      "cross-site-late-payment", current.payableAmountCents, f.now() - 1_000, f.now(), "CREDIT", f.snapshot.activeProviderAccountKey!);
    f.setNow(f.now() + 10);
    const result = new ReconciliationStore(f.database).reconcileEntry(entry.ledgerEntryId, f.now());
    assert.equal(result.kind, "ambiguous");
    assert.equal(f.orders.forSite(b.clientId).get(current.orderId).payment.status, "UNPAID");
    f.database.close();
    const reopened = await AppDatabase.open(f.config.databasePath, { masterKey: f.config.masterKey });
    try {
      const store = new ReconciliationStore(reopened);
      assert.deepEqual(store.reconcileEntry(entry.ledgerEntryId, f.now() + 1), result);
      assert.equal(reopened.read(db => Number(db.prepare("SELECT COUNT(*) AS count FROM outbox_events").get()!.count)), 0);
      store.settleManually({ financialOperationId: randomUUID(), orderId: current.orderId, ledgerEntryId: entry.ledgerEntryId,
        actorId: "admin", reason: "verified receipt from new website", now: f.now() + 2 });
      assert.equal(reopened.integrityCheck().ok, true);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

it("does not block a different collection account using the same amount", async () => {
  const f = await createSitePaymentFixture();
  try {
    const first = f.createSite("First wallet");
    const old = f.orders.forSite(first.clientId).create({ idempotency_key: "old", merchant_order_no: "old", amount_cents: 1000, product_name: "Old order" }).order;
    f.orders.forSite(first.clientId).close(old.orderId);
    let other = f.createSite("Other wallet");
    const accounts = new AlipayAccountStore(f.database, f.config.masterKey);
    const service = new AlipayAccountService({ store: accounts });
    const account = await service.create({ name: "Other wallet", app_id: "2026000000000009", code_payload: "https://qr.alipay.com/other-wallet",
      private_key: privatePem, platform_public_key: platformPem }, { actorId: "admin" });
    other = f.sites.update(other.clientId, { revision: other.revision, configuration: { ...other.configuration,
      collection: { mode: "FIXED", accounts: [{ account_id: account.id, weight: 1 }] } } }, { actorId: "admin" });
    const orders = new OrderService(f.database, () => f.settings.instanceSnapshot(), f.now, f.sites, undefined,
      { accounts: () => accounts.snapshots() }).forSite(other.clientId);
    const current = orders.create({ idempotency_key: "other", merchant_order_no: "other", amount_cents: 1000, product_name: "Other wallet order" }).order;
    assert.equal(current.payableAmountCents, old.payableAmountCents);
    f.setNow(f.now() + 2_000);
    const entry = recordLedgerEntry(new LedgerStore(f.database), { start: timestamp(f.now() - 60_000), end: timestamp(f.now() + 60_000) },
      "other-wallet-payment", current.payableAmountCents, f.now() - 1_000, f.now(), "CREDIT", account.provider_account_key!);
    f.setNow(f.now() + 10);
    assert.equal(new ReconciliationStore(f.database).reconcileEntry(entry.ledgerEntryId, f.now()).kind, "auto_settled");
    assert.equal(orders.get(current.orderId).payment.status, "CONFIRMED");
  } finally { f.close(); }
});
