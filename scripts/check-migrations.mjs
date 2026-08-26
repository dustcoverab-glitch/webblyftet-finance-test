import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const migrationDir = new URL("../migrations/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("./migration-manifest.json", import.meta.url), "utf8"));
const files = readdirSync(migrationDir).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
const errors = [];

for (let index = 0; index < files.length; index += 1) {
  const expected = String(index + 1).padStart(4, "0");
  if (!files[index].startsWith(`${expected}_`)) {
    errors.push(`Migration order gap: expected ${expected}_..., got ${files[index]}`);
  }
}

for (const [file, expectedHash] of Object.entries(manifest.locked)) {
  if (!files.includes(file)) {
    errors.push(`Locked migration missing: ${file}`);
    continue;
  }
  const body = readFileSync(join(migrationDir.pathname, file));
  const actualHash = createHash("sha256").update(body).digest("hex");
  if (actualHash !== expectedHash) {
    errors.push(`Locked migration modified: ${file}`);
  }
}

const duplicates = new Map();
for (const file of files) {
  const number = basename(file).slice(0, 4);
  duplicates.set(number, (duplicates.get(number) ?? 0) + 1);
}
for (const [number, count] of duplicates) {
  if (count > 1) errors.push(`Duplicate migration number: ${number}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Migration check passed (${files.length} migrations, ${Object.keys(manifest.locked).length} locked).`);
