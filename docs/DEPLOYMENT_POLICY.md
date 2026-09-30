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

## Seller Onboarding database gate

The Seller Onboarding migration has not yet been applied to the primary or production database. Before applying it or deploying backend code that depends on it, `DB_SYNCHRONIZE` must be explicitly set to `false`. The configured regular-admin registry must include the five approved operational accounts; any required password environment variables, including those for `shayan` and `ahmadi`, must be provisioned securely outside Git. God Admin must remain outside `ADMIN_USERS` and has no access to `/admin-panel/seller-onboarding/...`.

## Frontend native-runtime preflight

Frontend artifacts are built on Windows for an Ubuntu Linux x64/glibc production target. Packaging must derive the exact `sharp`, `@img/sharp-linux-x64`, and `@img/sharp-libvips-linux-x64` versions from the frontend lockfile, install them for the target platform in an isolated temporary directory, and reject the artifact before archiving if any required package or native library is absent. Production must not be repaired by installing dependencies manually on the server.

Before switching `current`, run the following checks from the extracted frontend standalone directory on Ubuntu:

1. Execute `node -e "const sharp=require('sharp'); sharp({create:{width:2,height:2,channels:3,background:'white'}}).resize(1,1).png().toBuffer().then(()=>console.log(sharp.versions)).catch(error=>{console.error(error);process.exit(1)})"`. It must load the Linux binding and complete an actual transform.
2. Start the candidate frontend with its normal production environment and request a known remote upload through `/_next/image` with `w=128` and an explicit quality.
3. Save the original and optimized responses temporarily, then compare both byte length and dimensions. The optimized response must be 128 pixels on its constrained axis and must be smaller than the original. A 200 response that has the original dimensions or byte length fails preflight.
4. Stop the candidate process and remove the temporary response files. Only after these checks and the normal health check pass may the release symlinks be changed.

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
