import { BIRD_PASSPORT_TAXONOMY } from './bird-passport-taxonomy.catalog';
import { BirdPassportTaxonomyService } from './bird-passport-taxonomy.service';

describe('BirdPassportTaxonomyService', () => {
  const service = new BirdPassportTaxonomyService();

  it('matches the complete deterministic website species order', () => {
    expect(service.list().map((item) => item.value)).toEqual([
      'macaw',
      'cockatoo',
      'african-grey',
      'green-cheek',
      'quaker',
      'alexandrine',
      'senegal',
      'rose-ringed',
      'sun-conure',
      'rosella',
      'eclectus',
      'lorikeet',
      'cockatiel',
      'lovebird',
    ]);
  });

  it('uses website slugs as values and Persian website names as labels', () => {
    expect(service.list()[0]).toEqual({
      value: 'macaw',
      label: 'ماکائو',
      subspecies: [
        { value: 'blue-gold', label: 'ماکائو آبی طلایی' },
        { value: 'red', label: 'ماکائو قرمز' },
        { value: 'scarlet', label: 'ماکائو اسکارلت' },
        { value: 'hahns', label: 'ماکائو هانس' },
        { value: 'harlequin', label: 'ماکائو هارلی کویین' },
      ],
    });
  });

  it('provides a safe self-leaf for every website species without child variants', () => {
    for (const value of [
      'alexandrine',
      'senegal',
      'rose-ringed',
      'cockatiel',
    ]) {
      const species = service.list().find((item) => item.value === value);
      expect(species?.subspecies).toEqual([{ value, label: species?.label }]);
    }
  });

  it('contains no empty, whitespace-padded or duplicate values', () => {
    const taxonomy = service.list();
    expect(new Set(taxonomy.map((item) => item.value)).size).toBe(
      taxonomy.length,
    );
    for (const species of taxonomy) {
      expect(species.value).toBe(species.value.trim());
      expect(species.label).toBe(species.label.trim());
      expect(species.subspecies.length).toBeGreaterThan(0);
      expect(new Set(species.subspecies.map((item) => item.value)).size).toBe(
        species.subspecies.length,
      );
      for (const subspecies of species.subspecies) {
        expect(subspecies.value).toBe(subspecies.value.trim());
        expect(subspecies.label).toBe(subspecies.label.trim());
      }
    }
  });

  it('returns response copies without exposing a mutable canonical catalog', () => {
    const first = service.list();
    first[0].label = 'changed';
    first[0].subspecies[0].label = 'changed';

    const fresh = service.list()[0];
    expect(fresh).toMatchObject({
      value: 'macaw',
      label: 'ماکائو',
    });
    expect(fresh.subspecies).toEqual(
      expect.arrayContaining([
        { value: 'blue-gold', label: 'ماکائو آبی طلایی' },
      ]),
    );
    expect(BIRD_PASSPORT_TAXONOMY[0].label).toBe('ماکائو');
  });
});
