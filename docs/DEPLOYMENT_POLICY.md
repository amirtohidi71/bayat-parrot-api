# Protected Deployment Policy

## Required production delivery model

Production delivery must use Build/Artifact deployment. Before any deployment decision is approved or implemented, it must first be reviewed for risks to Bayat Engine protection.

The final customer server must not retain:

- `.git`
- GitHub keys or repository access
- `src`
- tests
- development documentation
- development scripts
- source maps

Only the following may remain on the final customer server:

- runtime artifacts required to operate the service
- production dependencies
- environment configuration
- customer uploads
- the customer database

If GitHub access is used during temporary setup, all associated keys, credentials, tokens, configuration, and repository access must be removed before customer handoff.

## License behavior

- The service operates normally until `expiresAt`.
- After `expiresAt`, the service continues through a 10-day grace period with no public or admin message.
- After the grace period, the service enters a reversible maintenance mode.
- During maintenance mode, the public message must be exactly: "سرویس موقتاً در دسترس نیست. لطفاً با پشتیبانی فنی تماس بگیرید."
- License enforcement must never delete, lock, or modify any database, order, product, user, upload, or backup.
- Renewal restores service without redeployment.

This section defines required behavior only; it does not implement licensing.

## Documentation safety

Documentation must not contain private keys, secrets, hidden implementation details, or operational bypass instructions.

This documentation file is an internal development and governance document. It must not be included in customer deployment artifacts. Development documentation generally must also be excluded as specified above.
