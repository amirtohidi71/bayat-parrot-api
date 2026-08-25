import { ValidateBy, ValidationOptions } from 'class-validator';

const INTERNAL_ORIGIN = 'https://sales-chat.internal.invalid';
const PROTOCOL_LIKE_PATH_PATTERN = /^\/[a-z][a-z0-9+.-]*:/iu;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isSafeDecodedPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (value.includes('\\') || containsControlCharacter(value)) {
    return false;
  }
  if (value.includes('?') || value.includes('#')) return false;
  if (PROTOCOL_LIKE_PATH_PATTERN.test(value)) return false;

  try {
    const parsed = new URL(value, INTERNAL_ORIGIN);
    return (
      parsed.origin === INTERNAL_ORIGIN &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.host === new URL(INTERNAL_ORIGIN).host
    );
  } catch {
    return false;
  }
}

export function isInternalSalesChatSourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let candidate = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isSafeDecodedPath(candidate)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return false;
    }
    if (decoded === candidate) return true;
    candidate = decoded;
  }
  return false;
}

export function IsInternalSalesChatSourcePath(
  validationOptions?: ValidationOptions,
) {
  return ValidateBy(
    {
      name: 'isInternalSalesChatSourcePath',
      validator: {
        validate: isInternalSalesChatSourcePath,
        defaultMessage: () =>
          'sourcePath must be a canonical internal application path',
      },
    },
    validationOptions,
  );
}

export function canonicalProductSourcePath(product: {
  id: string;
  sku?: string | null;
  name: string;
}): string {
  const identifier = product.sku || product.id;
  const slug = product.name
    .replace(/[….]+$/gu, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 3)
    .join('-')
    .replace(/[^؀-ۿ0-9a-zA-Z-]/gu, '');
  return `/product/${encodeURIComponent(identifier)}/${slug}`;
}
