import { BadRequestException } from '@nestjs/common';
import { ProductCategorySlug } from '../entities/product.entity';

export enum ParrotTreatSubCategory {
  PELLET = 'pellet',
  FREEZE_DRIED = 'freeze-dried',
  PRESTIGE_SNACK = 'prestige-snack',
  SPRAY_MILLET = 'spray-millet',
  OMEGA_PELLET = 'omega-pellet',
  PROTEIN_PELLETS = 'protein-pellets',
  ENERGY_PELLETS = 'energy-pellets',
  FRUIT_PELLET = 'fruit-pellet',
}

export const PARROT_TREAT_SUBCATEGORIES = Object.values(ParrotTreatSubCategory);

export const SERLAK_WEIGHTS = ['100g', '500g', '1000g'] as const;
export const PELLET_BASED_TREAT_WEIGHTS = ['100g', '400g', '800g'] as const;

export const PELLET_BASED_TREAT_SUBCATEGORIES = [
  ParrotTreatSubCategory.PELLET,
  ParrotTreatSubCategory.OMEGA_PELLET,
  ParrotTreatSubCategory.PROTEIN_PELLETS,
  ParrotTreatSubCategory.ENERGY_PELLETS,
  ParrotTreatSubCategory.FRUIT_PELLET,
] as const;

type ProductCatalogFields = {
  categorySlug?: ProductCategorySlug | null;
  subCategory?: string | null;
  weight?: string | null;
};

export function isPelletBasedTreatSubCategory(
  subCategory: string | null | undefined,
): subCategory is (typeof PELLET_BASED_TREAT_SUBCATEGORIES)[number] {
  return PELLET_BASED_TREAT_SUBCATEGORIES.includes(
    subCategory as (typeof PELLET_BASED_TREAT_SUBCATEGORIES)[number],
  );
}

export function validateProductCatalogRules(product: ProductCatalogFields): void {
  if (product.categorySlug === ProductCategorySlug.PARROT_SERLAK) {
    validateRequiredWeight(product.weight, SERLAK_WEIGHTS, 'parrot-serlak');
    return;
  }

  if (product.categorySlug !== ProductCategorySlug.PARROT_TREATS) {
    return;
  }

  if (!product.subCategory) {
    throw new BadRequestException('Subcategory is required for parrot-treats');
  }

  if (!PARROT_TREAT_SUBCATEGORIES.includes(product.subCategory as ParrotTreatSubCategory)) {
    throw new BadRequestException(
      `Invalid parrot-treats subcategory. Allowed values: ${PARROT_TREAT_SUBCATEGORIES.join(', ')}`,
    );
  }

  if (isPelletBasedTreatSubCategory(product.subCategory)) {
    validateRequiredWeight(
      product.weight,
      PELLET_BASED_TREAT_WEIGHTS,
      'pellet-based parrot treats',
    );
  }
}

function validateRequiredWeight(
  weight: string | null | undefined,
  allowedWeights: readonly string[],
  context: string,
): void {
  if (!weight) {
    throw new BadRequestException(`Weight is required for ${context}`);
  }

  if (!allowedWeights.includes(weight)) {
    throw new BadRequestException(
      `Invalid weight for ${context}. Allowed values: ${allowedWeights.join(', ')}`,
    );
  }
}
