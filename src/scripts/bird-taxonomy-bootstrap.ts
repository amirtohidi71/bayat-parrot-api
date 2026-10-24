import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

export type TaxonChild = { id: string; key: string; displayName: string };
export type TaxonSpecies = TaxonChild & { subspecies: TaxonChild[] };
export type TaxonomyManifest = {
  schemaVersion: 1;
  manifestKey: string;
  sourceRevisions: { backend: string; frontend: string };
  review: { status: 'PROPOSED' | 'APPROVED'; notes: string[] };
  species: TaxonSpecies[];
};
type CatalogSpecies = {
  key: string;
  displayName: string;
  subspecies: Omit<TaxonChild, 'id'>[];
};

function invalid(): never {
  throw new Error('Invalid reviewed bird taxonomy manifest');
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join('|') !== [...keys].sort().join('|'))
    invalid();
  return result;
}
function text(value: unknown, key = false): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    Array.from(value).length > 100 ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    (key && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
  )
    invalid();
  return value;
}
function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  )
    invalid();
  return value;
}
export function explicitWebsiteTaxonomy(): CatalogSpecies[] {
  const path = resolve('src/bird-passports/bird-passport-taxonomy.catalog.ts');
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let rows: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'WEBSITE_PARROT_SPECIES' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    )
      rows = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!rows) invalid();
  const property = (node: ts.ObjectLiteralExpression, name: string) =>
    node.properties.find(
      (item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) && item.name.getText(source) === name,
    )?.initializer;
  const literal = (node: ts.Expression | undefined) =>
    node && ts.isStringLiteral(node) ? node.text : invalid();
  const option = (node: ts.Expression): Omit<TaxonChild, 'id'> => {
    if (!ts.isObjectLiteralExpression(node)) invalid();
    return {
      key: literal(property(node, 'value')),
      displayName: literal(property(node, 'label')),
    };
  };
  return rows.elements.map((node) => {
    if (!ts.isObjectLiteralExpression(node)) invalid();
    const children = property(node, 'subspecies');
    if (children && !ts.isArrayLiteralExpression(children)) invalid();
    return {
      ...option(node),
      subspecies: children ? children.elements.map(option) : [],
    };
  });
}
export function validateTaxonomyManifest(value: unknown): TaxonomyManifest {
  const root = object(value, [
    'schemaVersion',
    'manifestKey',
    'sourceRevisions',
    'review',
    'species',
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.manifestKey !== 'bayat-bird-taxonomy-v1' ||
    !Array.isArray(root.species)
  )
    invalid();
  const revisions = object(root.sourceRevisions, ['backend', 'frontend']);
  for (const revision of Object.values(revisions))
    if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision))
      invalid();
  const review = object(root.review, ['status', 'notes']);
  if (
    !['PROPOSED', 'APPROVED'].includes(String(review.status)) ||
    !Array.isArray(review.notes) ||
    review.notes.some(
      (note: unknown) => typeof note !== 'string' || !note.trim(),
    )
  )
    invalid();
  const parseOption = (value: unknown) => {
    const row = object(value, ['id', 'key', 'displayName']);
    return {
      id: id(row.id),
      key: text(row.key, true),
      displayName: text(row.displayName),
    };
  };
  const parents: unknown[] = root.species;
  const species = parents.map((value) => {
    const row = object(value, ['id', 'key', 'displayName', 'subspecies']);
    if (!Array.isArray(row.subspecies)) invalid();
    const children: unknown[] = row.subspecies;
    return {
      ...parseOption({
        id: row.id,
        key: row.key,
        displayName: row.displayName,
      }),
      subspecies: children.map(parseOption),
    };
  });
  const all = species.flatMap((parent) => [parent, ...parent.subspecies]);
  if (
    species.length !== 14 ||
    all.length !== 73 ||
    new Set(all.map((item) => item.id)).size !== all.length ||
    new Set(species.map((item) => item.key)).size !== species.length ||
    species.some(
      (parent) =>
        new Set(parent.subspecies.map((child) => child.key)).size !==
        parent.subspecies.length,
    )
  )
    invalid();
  // Exact comparison to source declarations, deliberately excluding Passport's synthetic self-leaves.
  const snapshot = species.map(({ key, displayName, subspecies }) => ({
    key,
    displayName,
    subspecies: subspecies.map(({ key, displayName }) => ({
      key,
      displayName,
    })),
  }));
  if (JSON.stringify(snapshot) !== JSON.stringify(explicitWebsiteTaxonomy()))
    invalid();
  return value as TaxonomyManifest;
}
export function readTaxonomyManifest(): TaxonomyManifest {
  const value: unknown = JSON.parse(
    readFileSync(
      resolve('scripts/taxonomy/bird-taxonomy-v1.proposed.json'),
      'utf8',
    ),
  );
  return validateTaxonomyManifest(value);
}
export function categoryCompatibility(manifest: TaxonomyManifest) {
  return manifest.species.map((parent) => ({
    speciesKey: parent.key,
    displayName: parent.displayName,
    matchesExistingSpeciesFilter: parent.key === parent.displayName,
    subspecies: parent.subspecies.map((child) => ({
      key: child.key,
      displayName: child.displayName,
      matchesExistingCatalogKey: child.key === child.displayName,
    })),
  }));
}
const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
export function generateTaxonomyBootstrapSql(value: unknown): string {
  const manifest = validateTaxonomyManifest(value);
  const parents = manifest.species
    .map((p) => '(' + [p.id, p.key, p.displayName].map(quote).join(',') + ')')
    .join(',\n');
  const children = manifest.species
    .flatMap((p) =>
      p.subspecies.map(
        (c) =>
          '(' + [c.id, p.id, c.key, c.displayName].map(quote).join(',') + ')',
      ),
    )
    .join(',\n');
  return String.raw`\set ON_ERROR_STOP on
-- Forward-only, insert-only. Generated from the reviewed fixed-identity manifest.
-- Review status: ${manifest.review.status}. PROPOSED output is for disposable tests only.
BEGIN;
SET LOCAL search_path = public, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('migration:breeder-listing-foundation-v1',0));
LOCK TABLE public.bird_species, public.bird_subspecies IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE pg_temp.proposed_species(id uuid PRIMARY KEY,key varchar(100) UNIQUE NOT NULL,"displayName" varchar(100) NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE pg_temp.proposed_subspecies(id uuid PRIMARY KEY,"speciesId" uuid NOT NULL,key varchar(100) NOT NULL,"displayName" varchar(100) NOT NULL,UNIQUE("speciesId",key)) ON COMMIT DROP;
INSERT INTO pg_temp.proposed_species VALUES
${parents};
INSERT INTO pg_temp.proposed_subspecies VALUES
${children};
DO $preflight$
BEGIN
  IF EXISTS (
    WITH expected(table_name,column_name,column_type) AS (VALUES
      ('bird_species','id','uuid'),('bird_species','key','character varying(100)'),('bird_species','displayName','character varying(100)'),
      ('bird_species','createdAt','timestamp with time zone'),('bird_species','updatedAt','timestamp with time zone'),
      ('bird_subspecies','id','uuid'),('bird_subspecies','speciesId','uuid'),('bird_subspecies','key','character varying(100)'),
      ('bird_subspecies','displayName','character varying(100)'),('bird_subspecies','createdAt','timestamp with time zone'),('bird_subspecies','updatedAt','timestamp with time zone'))
    SELECT 1 FROM expected e LEFT JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||e.table_name) AND a.attname=e.column_name AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attname IS NULL OR NOT a.attnotnull OR format_type(a.atttypid,a.atttypmod)<>e.column_type
  ) OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.bird_species'::regclass,'public.bird_subspecies'::regclass) AND (relkind<>'r' OR relrowsecurity))
    THEN RAISE EXCEPTION 'Incompatible taxonomy schema' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.bird_species s JOIN public.bird_subspecies c USING(id))
    OR EXISTS(SELECT 1 FROM pg_temp.proposed_species p JOIN public.bird_subspecies c USING(id))
    OR EXISTS(SELECT 1 FROM pg_temp.proposed_subspecies p JOIN public.bird_species s USING(id))
    THEN RAISE EXCEPTION 'Taxonomy cross-level identity conflict' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM pg_temp.proposed_species p JOIN public.bird_species s ON s.id=p.id WHERE s.key<>p.key)
    OR EXISTS(SELECT 1 FROM pg_temp.proposed_subspecies p JOIN public.bird_subspecies s ON s.id=p.id WHERE s.key<>p.key)
    THEN RAISE EXCEPTION 'Taxonomy identity conflict' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM pg_temp.proposed_subspecies p JOIN public.bird_subspecies s ON s.id=p.id WHERE s."speciesId"<>p."speciesId")
    THEN RAISE EXCEPTION 'Taxonomy parent conflict' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM pg_temp.proposed_species p JOIN public.bird_species s ON s.key=p.key WHERE s.id<>p.id)
    OR EXISTS(SELECT 1 FROM pg_temp.proposed_subspecies p JOIN public.bird_subspecies s ON s."speciesId"=p."speciesId" AND s.key=p.key WHERE s.id<>p.id)
    THEN RAISE EXCEPTION 'Taxonomy key conflict' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM pg_temp.proposed_species p JOIN public.bird_species s ON s.id=p.id WHERE s."displayName"<>p."displayName")
    OR EXISTS(SELECT 1 FROM pg_temp.proposed_subspecies p JOIN public.bird_subspecies s ON s.id=p.id WHERE s."displayName"<>p."displayName")
    THEN RAISE EXCEPTION 'Taxonomy label conflict' USING ERRCODE='23514'; END IF;
END $preflight$;
INSERT INTO public.bird_species(id,key,"displayName")
  SELECT p.* FROM pg_temp.proposed_species p WHERE NOT EXISTS(SELECT 1 FROM public.bird_species s WHERE s.id=p.id);
INSERT INTO public.bird_subspecies(id,"speciesId",key,"displayName")
  SELECT p.* FROM pg_temp.proposed_subspecies p WHERE NOT EXISTS(SELECT 1 FROM public.bird_subspecies s WHERE s.id=p.id);
COMMIT;
`;
}
export function generateApprovedTaxonomyBootstrapSql(value: unknown): string {
  const manifest = validateTaxonomyManifest(value);
  if (manifest.review.status !== 'APPROVED')
    throw new Error(
      'Manifest is PROPOSED: owner approval required; no SQL emitted',
    );
  return generateTaxonomyBootstrapSql(manifest);
}
if (require.main === module) {
  process.stdout.write(
    generateApprovedTaxonomyBootstrapSql(readTaxonomyManifest()),
  );
}
