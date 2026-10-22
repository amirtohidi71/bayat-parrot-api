import { isUUID } from 'class-validator';
import { BreederTaxonErrorCode, taxonError } from './breeder-taxon.errors';

// Shared canonical UUID policy from the taxon API, including service callers.
export const normalizeTaxonUuid = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export function requireTaxonUuid(value: unknown): string {
  const normalized = normalizeTaxonUuid(value);
  if (typeof normalized !== 'string' || !isUUID(normalized))
    taxonError(400, BreederTaxonErrorCode.INVALID_SELECTION);
  return normalized;
}
