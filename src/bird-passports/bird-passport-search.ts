export const ADMIN_BIRD_PASSPORT_SEARCH_MAX_LENGTH = 100;

export function normalizeAdminBirdPassportSearch(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > ADMIN_BIRD_PASSPORT_SEARCH_MAX_LENGTH)
    throw new RangeError('Bird passport search exceeds 100 characters');
  return normalized;
}

export function escapePostgresLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
