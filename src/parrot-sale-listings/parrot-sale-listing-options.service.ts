import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  Product,
  ProductCategorySlug,
  ProductStatus,
} from '../products/entities/product.entity';
import {
  ParrotSaleListingErrorCode,
  parrotSaleListingError,
} from './parrot-sale-listing.errors';

export type ParrotSaleListingOptions = {
  species: string[];
  subspeciesBySpecies: Record<string, string[]>;
  colors: string[];
};

export type ParrotSaleListingSelection = {
  species: string;
  subspecies?: string | null;
  colors?: string[] | null;
};

type ProductOptionRow = Pick<Product, 'species' | 'subspecies' | 'colors'>;

@Injectable()
export class ParrotSaleListingOptionsService {
  constructor(private readonly dataSource: DataSource) {}

  getOptions(manager?: EntityManager): Promise<ParrotSaleListingOptions> {
    const products = (manager ?? this.dataSource.manager).getRepository(
      Product,
    );
    return this.loadOptions(products);
  }

  async assertValidSelection(
    selection: ParrotSaleListingSelection,
    manager: EntityManager,
  ): Promise<void> {
    const options = await this.getOptions(manager);
    if (!options.species.includes(selection.species)) {
      this.invalidOption('species');
    }
    if (
      selection.subspecies &&
      !(options.subspeciesBySpecies[selection.species] ?? []).includes(
        selection.subspecies,
      )
    ) {
      this.invalidOption('subspecies');
    }
    if (selection.colors?.some((color) => !options.colors.includes(color))) {
      this.invalidOption('colors');
    }
  }

  private async loadOptions(
    products: Repository<Product>,
  ): Promise<ParrotSaleListingOptions> {
    const rows: ProductOptionRow[] = await products.find({
      select: {
        species: true,
        subspecies: true,
        colors: true,
      },
      where: {
        categorySlug: ProductCategorySlug.BUY_PARROT,
        status: ProductStatus.PUBLISHED,
      },
    });
    const species = new Set<string>();
    const colors = new Set<string>();
    const subspecies = new Map<string, Set<string>>();

    for (const row of rows) {
      const speciesValue = this.clean(row.species);
      if (!speciesValue) continue;
      species.add(speciesValue);

      const subspeciesValue = this.clean(row.subspecies);
      if (subspeciesValue) {
        const values = subspecies.get(speciesValue) ?? new Set<string>();
        values.add(subspeciesValue);
        subspecies.set(speciesValue, values);
      }
      for (const color of row.colors ?? []) {
        const colorValue = this.clean(color);
        if (colorValue) colors.add(colorValue);
      }
    }

    const sortedSpecies = this.sorted(species);
    return {
      species: sortedSpecies,
      subspeciesBySpecies: Object.fromEntries(
        sortedSpecies.map((value) => [
          value,
          this.sorted(subspecies.get(value) ?? []),
        ]),
      ),
      colors: this.sorted(colors),
    };
  }

  private clean(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private sorted(values: Iterable<string>): string[] {
    return [...values].sort((left, right) => left.localeCompare(right, 'fa'));
  }

  private invalidOption(field: string): never {
    throw parrotSaleListingError(
      HttpStatus.BAD_REQUEST,
      ParrotSaleListingErrorCode.INVALID_OPTION,
      `Invalid parrot sale listing ${field} option`,
    );
  }
}
