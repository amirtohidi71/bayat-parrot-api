import { ValidationPipe } from '@nestjs/common';
import {
  CreateBreederParrotSaleListingDto,
  UpdateParrotSaleListingDto,
} from './dto/parrot-sale-listing.dto';
import { RequestBreederTaxaDto } from '../breeder-listings/breeder-taxon.dto';
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  validationError: { target: false, value: false },
});
describe('listing/taxon UUID compatibility', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'uses the existing API UUID policy for version %i',
    async (version) => {
      const speciesId = `123e4567-e89b-${version}2d3-a456-426614174000`,
        subspeciesId = `223e4567-e89b-${version}2d3-a456-426614174000`;
      const selected = {
        speciesId: ' ' + speciesId.toUpperCase() + ' ',
        subspeciesId: subspeciesId.toUpperCase(),
      };
      const request = (await pipe.transform(
        {
          requestId: '323e4567-e89b-42d3-a456-426614174000',
          selections: [
            {
              speciesId: selected.speciesId,
              subspeciesIds: [selected.subspeciesId],
            },
          ],
        },
        { type: 'body', metatype: RequestBreederTaxaDto },
      )) as RequestBreederTaxaDto;
      expect(request.selections[0]).toEqual({
        speciesId,
        subspeciesIds: [subspeciesId],
      });
      const created = (await pipe.transform(
        { name: 'Fixture', requestedPrice: 100, ...selected },
        { type: 'body', metatype: CreateBreederParrotSaleListingDto },
      )) as CreateBreederParrotSaleListingDto;
      expect(created).toMatchObject({ speciesId, subspeciesId });
      const updated = (await pipe.transform(selected, {
        type: 'body',
        metatype: UpdateParrotSaleListingDto,
      })) as UpdateParrotSaleListingDto;
      expect(updated).toMatchObject({ speciesId, subspeciesId });
    },
  );
  it.each([
    null,
    [],
    {},
    42,
    '',
    'invalid',
    '123e4567-e89b-92d3-a456-426614174000',
  ])('malformed create IDs fail with 400: %j', async (speciesId: unknown) => {
    await expect(
      pipe.transform(
        {
          name: 'Fixture',
          requestedPrice: 100,
          speciesId,
          subspeciesId: '223e4567-e89b-42d3-a456-426614174000',
        },
        { type: 'body', metatype: CreateBreederParrotSaleListingDto },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
