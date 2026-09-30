import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  AdminBreederCallDto,
  AdminNoteDto,
  AdminRejectDto,
  SubmitBreederApplicationDto,
} from './seller-onboarding.dto';
import { BreederCallOutcome } from '../entities/breeder-application.entity';

const pipe = new ValidationPipe({ whitelist: true, transform: true });

const basePayload = () => ({
  breederName: 'Breeder',
  city: 'Tehran',
  species: ['Cockatiel'],
  experienceYears: 5,
  approximateBirdCount: 10,
  preferredContactTime: 'Morning',
});

async function transform(
  payload: Record<string, unknown>,
): Promise<SubmitBreederApplicationDto> {
  return transformDto(SubmitBreederApplicationDto, payload);
}

async function transformDto<T>(
  metatype: new () => T,
  payload: Record<string, unknown>,
): Promise<T> {
  const result: unknown = await pipe.transform(payload, {
    type: 'body',
    metatype,
  });
  return result as T;
}

describe('SubmitBreederApplicationDto strict integer conversion', () => {
  it.each([
    ['experienceYears', 12, 12],
    ['experienceYears', '12', 12],
    ['experienceYears', '0', 0],
    ['approximateBirdCount', 12, 12],
    ['approximateBirdCount', '12', 12],
    ['approximateBirdCount', '0', 0],
  ] as const)('accepts %s=%p as integer %p', async (field, input, expected) => {
    const result = await transform({ ...basePayload(), [field]: input });

    expect(result[field]).toBe(expected);
    expect(typeof result[field]).toBe('number');
  });

  const invalidValues: ReadonlyArray<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace', '   '],
    ['true', true],
    ['false', false],
    ['null', null],
    ['object', { value: 12 }],
    ['array', [12]],
    ['decimal number', 1.5],
    ['decimal string', '1.5'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['mixed string', '12abc'],
    ['scientific notation', '1e2'],
  ];

  it.each([
    ['experienceYears', -1],
    ['experienceYears', 101],
    ['approximateBirdCount', -1],
    ['approximateBirdCount', 100001],
  ] as const)('rejects out-of-range %s=%p', async (field, input) => {
    await expect(
      transform({ ...basePayload(), [field]: input }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  for (const field of ['experienceYears', 'approximateBirdCount'] as const) {
    it.each(invalidValues)(`rejects ${field} %s`, async (_label, input) => {
      await expect(
        transform({ ...basePayload(), [field]: input }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  }
});

describe('seller onboarding optional text normalization', () => {
  const optionalTextCases = [
    [SubmitBreederApplicationDto, basePayload(), 'description'],
    [AdminNoteDto, {}, 'internalAdminNote'],
    [AdminRejectDto, { rejectionReason: 'Not eligible' }, 'internalAdminNote'],
    [
      AdminBreederCallDto,
      { outcome: BreederCallOutcome.SUCCESSFUL },
      'privateCallNote',
    ],
  ] as const;

  it.each(optionalTextCases)(
    'normalizes whitespace-only %s.%s to undefined',
    async (metatype, payload, field) => {
      const result = await transformDto(metatype, {
        ...payload,
        [field]: '   ',
      });
      expect((result as Record<string, unknown>)[field]).toBeUndefined();
    },
  );

  it.each(optionalTextCases)(
    'trims optional text for %s.%s',
    async (metatype, payload, field) => {
      const result = await transformDto(metatype, {
        ...payload,
        [field]: '  optional text  ',
      });
      expect((result as Record<string, unknown>)[field]).toBe('optional text');
    },
  );

  for (const [metatype, payload, field] of optionalTextCases) {
    it.each([42, null, { text: 'value' }, ['value']])(
      `rejects non-string ${metatype.name}.${field}: %p`,
      async (value) => {
        await expect(
          transformDto(metatype, { ...payload, [field]: value }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );
  }

  it.each([
    [
      'instagramUrl',
      ' http://example.com/profile ',
      'http://example.com/profile',
    ],
    ['websiteUrl', ' https://example.com/path ', 'https://example.com/path'],
  ] as const)('accepts and trims valid %s', async (field, value, expected) => {
    const result = await transform({ ...basePayload(), [field]: value });
    expect(result[field]).toBe(expected);
  });

  it.each(['instagramUrl', 'websiteUrl'] as const)(
    'normalizes whitespace-only %s to undefined',
    async (field) => {
      const result = await transform({ ...basePayload(), [field]: '   ' });
      expect(result[field]).toBeUndefined();
    },
  );

  it.each([
    'https://user:pass@example.com',
    'https://user@example.com',
    'javascript:alert(1)',
    'data:text/plain,value',
    'ftp://example.com/file',
    'example.com',
    'https://',
  ])('rejects unsafe or incomplete optional URL %p', async (value) => {
    await expect(
      transform({ ...basePayload(), instagramUrl: value }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([42, null, { url: 'https://example.com' }, ['https://example.com']])(
    'rejects non-string optional URL %p',
    async (value) => {
      await expect(
        transform({ ...basePayload(), websiteUrl: value }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});
