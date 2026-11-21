"""Offline schema/migration consistency checks; not PostgreSQL execution tests."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# The first deployed migration is immutable even as subsequent schemas evolve.
SCHEMA = ROOT / "test/fixtures/phase1.schema.prisma"
CURRENT_SCHEMA = ROOT / "prisma/schema.prisma"
MIGRATION = ROOT / "prisma/migrations/202611050001_initial/migration.sql"
RENDERER = ROOT / "scripts/render-initial-migration.py"
REQUIRED_TABLES = {
    "users", "user_profiles", "roles", "live_streams", "stream_viewers", "follows",
    "live_messages", "gifts", "gift_transactions", "coin_packages", "coin_wallets",
    "wallet_ledger", "payment_orders", "payment_webhooks", "creator_earnings",
    "revenue_splits", "payout_requests", "payout_accounts", "identity_verifications",
    "refunds", "disputes", "notifications", "reports", "moderation_actions",
    "admin_audit_logs", "platform_settings",
}


class SchemaStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = SCHEMA.read_text()
        cls.sql = MIGRATION.read_text()
        cls.temp = tempfile.TemporaryDirectory(prefix="livestar-schema-static-")
        cls.work = Path(cls.temp.name)
        (cls.work / "scripts").mkdir()
        (cls.work / "prisma").mkdir()
        (cls.work / "test/fixtures").mkdir(parents=True)
        shutil.copy2(SCHEMA, cls.work / "test/fixtures/phase1.schema.prisma")
        shutil.copy2(RENDERER, cls.work / "scripts/render-initial-migration.py")
        subprocess.run([sys.executable, str(cls.work / "scripts/render-initial-migration.py")], check=True, capture_output=True, text=True)
        cls.rendered = (cls.work / "prisma/migrations/202611050001_initial/migration.sql").read_text()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def test_model_and_enum_inventory(self) -> None:
        self.assertEqual(len(re.findall(r"^model \w+ \{", self.schema, re.M)), 35)
        self.assertEqual(len(re.findall(r"^enum \w+ \{", self.schema, re.M)), 14)
        tables = set(re.findall(r'@@map\("([^"]+)"\)', self.schema))
        self.assertEqual(len(tables), 35)
        self.assertTrue(REQUIRED_TABLES.issubset(tables), REQUIRED_TABLES - tables)

    def test_current_phase_two_schema_keeps_financial_tables_and_adds_auth_challenges(self) -> None:
        current = CURRENT_SCHEMA.read_text()
        tables = set(re.findall(r'@@map\("([^"]+)"\)', current))
        self.assertTrue(REQUIRED_TABLES.issubset(tables))
        self.assertEqual(len(tables), 41)
        self.assertIn("auth_challenges", tables)
        self.assertTrue({"pk_battles", "stream_likes"}.issubset(tables))
        self.assertTrue({"du_wallets", "du_gifts", "du_transactions"}.issubset(tables))
        self.assertRegex(current, r"enum SessionClientType\s*\{\s*WEB\s+MOBILE\s*\}")
        self.assertRegex(current, r"birthDate\s+DateTime\?\s+@map\(\"birth_date\"\) @db.Date")

    def test_committed_migration_matches_schema_renderer_exactly(self) -> None:
        self.assertEqual(self.rendered, self.sql, "Schema and initial SQL differ. Review the schema change, then regenerate the initial migration only before first deployment.")

    def test_render_is_deterministic(self) -> None:
        subprocess.run([sys.executable, str(self.work / "scripts/render-initial-migration.py")], check=True, capture_output=True, text=True)
        repeated = (self.work / "prisma/migrations/202611050001_initial/migration.sql").read_text()
        self.assertEqual(self.rendered, repeated)

    def test_sql_inventory_and_foreign_key_targets(self) -> None:
        tables = set(re.findall(r'^CREATE TABLE "([^"]+)"', self.sql, re.M))
        enums = re.findall(r'^CREATE TYPE "([^"]+)" AS ENUM', self.sql, re.M)
        foreign_keys = re.findall(r'^ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY .* REFERENCES "([^"]+)"', self.sql, re.M)
        self.assertEqual(len(tables), 35)
        self.assertEqual(len(enums), 14)
        self.assertEqual(len(foreign_keys), 55)
        self.assertTrue(REQUIRED_TABLES.issubset(tables))
        for source, target in foreign_keys:
            self.assertIn(source, tables)
            self.assertIn(target, tables)
        self.assertEqual(len(re.findall(r'^CREATE (?:UNIQUE )?INDEX ', self.sql, re.M)), 89)

    def test_ledger_units_and_composite_currency_foreign_keys(self) -> None:
        self.assertIn('CREATE TYPE "LedgerUnit" AS ENUM (\'LIVECOIN\', \'USD_MICRO\');', self.sql)
        for target, id_column in (("ledger_accounts", "account_id"), ("ledger_journals", "journal_id")):
            self.assertIn(f'CREATE UNIQUE INDEX "{target}_id_unit_key" ON "{target}" ("id", "unit");', self.sql)
            self.assertRegex(self.sql, rf'FOREIGN KEY \("{id_column}", "unit"\) REFERENCES "{target}" \("id", "unit"\) ON DELETE RESTRICT')
        self.assertIn('CREATE UNIQUE INDEX "wallet_ledger_journal_id_account_id_key" ON "wallet_ledger" ("journal_id", "account_id");', self.sql)

    def test_idempotency_and_provider_event_deduplication(self) -> None:
        for table in ("ledger_journals", "payment_orders", "gift_transactions", "payout_requests", "refunds"):
            self.assertIn(f'CREATE UNIQUE INDEX "{table}_idempotency_key_key" ON "{table}" ("idempotency_key");', self.sql)
        self.assertIn('CREATE UNIQUE INDEX "payment_webhooks_provider_provider_event_id_key" ON "payment_webhooks" ("provider", "provider_event_id");', self.sql)

    def test_money_uses_exact_integer_and_decimal_types(self) -> None:
        self.assertRegex(self.sql, r'"balance" BIGINT NOT NULL DEFAULT 0')
        self.assertRegex(self.sql, r'"amount" BIGINT NOT NULL')
        self.assertRegex(self.sql, r'"amount_minor" BIGINT NOT NULL')
        self.assertRegex(self.sql, r'"eligible_net_usd_micros" BIGINT NOT NULL')
        self.assertRegex(self.sql, r'"fx_rate_to_usd" DECIMAL\(30, 12\)')
        self.assertNotRegex(self.sql, r'\b(?:REAL|DOUBLE PRECISION|MONEY)\b')

    def test_financial_foreign_keys_restrict_deletion(self) -> None:
        financial_tables = {
            "ledger_accounts", "ledger_journals", "wallet_ledger", "coin_wallets",
            "payment_orders", "payment_webhooks", "coin_lots", "gift_transactions",
            "gift_allocations", "creator_earnings", "payout_accounts", "payout_requests",
            "identity_verifications", "refunds", "disputes", "admin_audit_logs",
        }
        for line in self.sql.splitlines():
            match = re.match(r'ALTER TABLE "([^"]+)" .* FOREIGN KEY ', line)
            if match and match[1] in financial_tables:
                self.assertIn("ON DELETE RESTRICT", line)


if __name__ == "__main__":
    unittest.main()
