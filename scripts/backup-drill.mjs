const database = process.argv[2] ?? "webblyftet-finance-test";
const bucket = process.argv[3] ?? "webblyftet-finance-test-receipts";
const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");

console.log(`Finance Test backup/restore drill for D1=${database} R2=${bucket}`);
console.log("");
console.log("Pre-migration backup commands:");
console.log(`npx wrangler d1 backup create ${database}`);
console.log(`npx wrangler d1 export ${database} --remote --output=./backups/${database}-${date}.sql`);
console.log("");
console.log("R2 inventory guidance:");
console.log(`npx wrangler r2 object list ${bucket} --prefix receipts/`);
console.log("Store the object inventory together with the D1 export so receipt mappings can be reconciled.");
console.log("");
console.log("Restore validation checklist:");
console.log("1. Restore only after an incident decision and after backing up the current damaged state.");
console.log("2. Validate customers, invoices, subscriptions, payments, receipts and provider mappings.");
console.log("3. Run health, Access, Stripe webhook invalid-signature and customer-order public smoke tests.");
console.log("4. Document restored backup ID/export filename, commit SHA and Worker Version ID.");
