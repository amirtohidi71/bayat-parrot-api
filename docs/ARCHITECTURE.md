# Architecture and Ownership

## Ownership boundaries

The customer owns all business data, including:

- products
- orders
- users
- content
- uploads
- the database and all backups

Amir owns the Bayat Engine source code, architecture, and reusable business logic.

Engine ownership is separate from customer data ownership. Neither ownership boundary transfers or diminishes the other: the customer retains ownership and control of its business data, while Amir retains ownership of the Bayat Engine.

## Runtime architecture

The current production request and data flow is:

`Nginx → Next.js → NestJS → PostgreSQL`

Customer data must remain on infrastructure controlled by the customer, including customer uploads, the production database, and backups.

### Frontend build and runtime platform

The production frontend artifact is built on Windows and runs on Ubuntu Linux x64 with glibc. The standalone Next.js artifact must therefore contain the lockfile-matched `sharp`, `@img/sharp-linux-x64`, and `@img/sharp-libvips-linux-x64` packages. Packaging installs these dependencies in an isolated temporary directory for the target platform and copies only the required Linux runtime into `.next/standalone`; it must not modify the frontend worktree or include a Windows native binding in the published artifact.

## Deployment exclusion

This documentation file is for internal development and governance only. It must not be included in customer deployment artifacts.
