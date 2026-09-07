import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The caller loads a 32-byte key from protected runtime config when needed.
 * The key is never persisted in the DB. Bind each ciphertext to its appointment
 * AND field (e.g. `${appointmentId}:nationalId`) to prevent substitution.
 * Key rotation needs an explicit migration/operational procedure before launch.
 */
export function encryptVetField(
  value: string,
  key: Buffer,
  context: string,
): string {
  validateInputs(key, context);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptVetField(
  envelope: string,
  key: Buffer,
  context: string,
): string {
  validateInputs(key, context);
  if (
    !/^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$/.test(envelope)
  ) {
    throw new Error('Invalid vet encrypted field');
  }
  const [, nonce, tag, ciphertext] = envelope.split(':');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(nonce, 'base64url'),
    );
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Unable to decrypt vet field');
  }
}

function validateInputs(key: Buffer, context: string): void {
  if (key.length !== 32 || !context.trim()) {
    throw new Error(
      'Vet field encryption requires a 32-byte key and field context',
    );
  }
}
