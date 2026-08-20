# ADR-006: User Pseudonymization via Random UUID

## Decision

On first hook run, generate a random UUID and store it in `~/.claude/token-usage-id`. This UUID is included as `user_id` in every entry.

```js
function getUserId() {
  if (fs.existsSync(USER_ID_PATH)) return fs.readFileSync(USER_ID_PATH, 'utf8').trim();
  const id = crypto.randomUUID();
  fs.writeFileSync(USER_ID_PATH, id);
  return id;
}
```

## Why

- Per-user analysis requires a stable identifier, but privacy/GDPR requires that the actual user not be identifiable (or only with great difficulty).
- A random UUID with no link back to username/hostname makes de-anonymization impossible for anyone, including under legal order — this is the point, not a gap.
- Aggregation per user across sessions and devices works as long as the file isn't deleted; deleting it starts a fresh identity with no way to reattribute past entries.

## Alternatives considered

- **SHA-256(username)**: looks anonymous but a dictionary attack over known company usernames recovers the mapping in milliseconds. Not sufficient protection.
- **HMAC(username, secret)**: secure against dictionary attacks and allows controlled de-anonymization by whoever holds the key, but requires secure key distribution/rotation — a
  real option if controlled de-anonymization is ever required (breaking change for historical data).
- **SHA-256(username + hostname)**: improves uniqueness but still vulnerable to dictionary attacks.
