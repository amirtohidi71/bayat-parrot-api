import { Injectable } from '@nestjs/common';
import {
  BIRD_PASSPORT_TAXONOMY,
  BirdPassportTaxonomyItem,
} from './bird-passport-taxonomy.catalog';

export type { BirdPassportTaxonomyItem } from './bird-passport-taxonomy.catalog';

@Injectable()
export class BirdPassportTaxonomyService {
  list(): BirdPassportTaxonomyItem[] {
    return BIRD_PASSPORT_TAXONOMY.map((species) => ({
      value: species.value,
      label: species.label,
      subspecies: species.subspecies.map((option) => ({ ...option })),
    }));
  }
}
