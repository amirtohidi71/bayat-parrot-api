import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIRD_PASSPORT_TAXONOMY } from '../bird-passports/bird-passport-taxonomy.catalog';
import {
  categoryCompatibility,
  generateApprovedTaxonomyBootstrapSql,
  explicitWebsiteTaxonomy,
  generateTaxonomyBootstrapSql,
  readTaxonomyManifest,
  validateTaxonomyManifest,
} from '../scripts/bird-taxonomy-bootstrap';

describe('reviewed bird taxonomy approved manifest', () => {
  it('contains exactly the 14 original parents and 59 explicit children with no generated self-leaves', () => {
    const manifest = readTaxonomyManifest();
    expect(manifest.species).toHaveLength(14);
    expect(manifest.species.flatMap((p) => p.subspecies)).toHaveLength(59);
    expect(
      manifest.species.filter((p) => !p.subspecies.length).map((p) => p.key),
    ).toEqual(['alexandrine', 'senegal', 'rose-ringed', 'cockatiel']);
    expect(BIRD_PASSPORT_TAXONOMY.flatMap((p) => p.subspecies)).toHaveLength(
      63,
    );
    expect(explicitWebsiteTaxonomy().map((p) => p.key)).toEqual(
      manifest.species.map((p) => p.key),
    );
    expect(manifest.review.status).toBe('APPROVED');
  });
  it('pins all 73 identities and emits deterministic SQL with no runtime UUID generation or history writes', () => {
    const manifest = readTaxonomyManifest();
    const identity = manifest.species
      .flatMap((p) => [p.id, ...p.subspecies.map((c) => c.id)])
      .join('\n');
    expect(createHash('sha256').update(identity).digest('hex')).toBe(
      '3b1d3bfd798e8474ded5863f4342a7379cda79668bf792048dcc37a6b2b5b995',
    );
    const sql = generateTaxonomyBootstrapSql(manifest);
    expect(generateTaxonomyBootstrapSql(readTaxonomyManifest())).toBe(sql);
    expect(sql).toMatch(/^\\set ON_ERROR_STOP on/);
    expect(sql).toMatch(/\nBEGIN;/);
    expect(sql).toMatch(/\nCOMMIT;\n$/);
    expect(sql).not.toMatch(
      /(?<!pg_temp\.)\bproposed_(?:species|subspecies)\b/,
    );
    expect(sql).toContain('CREATE TEMP TABLE pg_temp.proposed_species');
    expect(sql).toContain('CREATE TEMP TABLE pg_temp.proposed_subspecies');
    expect(sql).not.toMatch(
      /randomUUID|uuid_generate|ON CONFLICT|\bUPDATE\s+public\.|\bDELETE\s+FROM\b|\bTRUNCATE\b/,
    );
    expect(sql.match(/INSERT INTO public\.[a-z_]+/g)).toEqual([
      'INSERT INTO public.bird_species',
      'INSERT INTO public.bird_subspecies',
    ]);
  });
  it.each([
    'extra',
    'bad-id',
    'duplicate-id',
    'duplicate-key',
    'moved-child',
    'changed-label',
    'whitespace',
    'invented-child',
    'alias-merge',
  ])(
    'fails closed for %s without silently normalizing catalog identity',
    (kind) => {
      const manifest = structuredClone(readTaxonomyManifest());
      if (kind === 'extra') Object.assign(manifest, { permissions: [] });
      if (kind === 'bad-id') manifest.species[0].id = 'not-a-uuid';
      if (kind === 'duplicate-id')
        manifest.species[1].id = manifest.species[0].id;
      if (kind === 'duplicate-key')
        manifest.species[1].key = manifest.species[0].key;
      if (kind === 'moved-child')
        manifest.species[1].subspecies.push(
          manifest.species[0].subspecies.pop()!,
        );
      if (kind === 'changed-label')
        manifest.species[0].displayName = 'Different label';
      if (kind === 'whitespace') manifest.species[0].displayName += ' ';
      if (kind === 'invented-child')
        manifest.species[5].subspecies.push({
          ...manifest.species[0].subspecies[0],
        });
      if (kind === 'alias-merge')
        manifest.species[0].subspecies[1].key =
          manifest.species[0].subspecies[2].key;
      expect(() => validateTaxonomyManifest(manifest)).toThrow(
        'Invalid reviewed bird taxonomy manifest',
      );
    },
  );
  it('records every exact public-filter mismatch; does not claim labels are slug-compatible', () => {
    const report = categoryCompatibility(readTaxonomyManifest());
    expect(report).toHaveLength(14);
    expect(report.every((p) => !p.matchesExistingSpeciesFilter)).toBe(true);
    const children = report.flatMap((p) => p.subspecies);
    expect(children).toHaveLength(59);
    expect(children.every((c) => !c.matchesExistingCatalogKey)).toBe(true);
    const policy = readFileSync(
      resolve('src/parrot-sale-listings/breeder-listing-eligibility.ts'),
      'utf8',
    );
    expect(policy).toContain('species: species.displayName');
    expect(policy).toContain('subspecies: subspecies.displayName');
    const filters = readFileSync(
      resolve('src/products/products.service.ts'),
      'utf8',
    );
    expect(filters).toContain('product.species IN (:...species)');
    expect(
      readFileSync(resolve('src/products/dto/find-products.dto.ts'), 'utf8'),
    ).not.toContain('subspecies?:');
  });
  it('approved output gate rejects proposed manifests without emitting SQL', () => {
    const manifest = structuredClone(readTaxonomyManifest());
    manifest.review.status = 'PROPOSED';
    expect(() => generateApprovedTaxonomyBootstrapSql(manifest)).toThrow(
      'Manifest is PROPOSED',
    );
  });
  it('CLI emits only the exact deterministic approved SQL without executing it', () => {
    const result = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register', 'src/scripts/bird-taxonomy-bootstrap.ts'],
      {
        encoding: 'utf8',
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      generateApprovedTaxonomyBootstrapSql(readTaxonomyManifest()),
    );
    expect(result.stderr).toBe('');
  });
});
