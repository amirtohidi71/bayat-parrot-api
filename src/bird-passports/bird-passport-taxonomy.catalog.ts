export type BirdPassportTaxonomyOption = {
  value: string;
  label: string;
};

export type BirdPassportTaxonomyItem = BirdPassportTaxonomyOption & {
  readonly subspecies: readonly BirdPassportTaxonomyOption[];
};

type WebsiteSpecies = BirdPassportTaxonomyOption & {
  subspecies?: readonly BirdPassportTaxonomyOption[];
};

const WEBSITE_PARROT_SPECIES: readonly WebsiteSpecies[] = [
  {
    value: 'macaw',
    label: 'ماکائو',
    subspecies: [
      { value: 'blue-gold', label: 'ماکائو آبی طلایی' },
      { value: 'red', label: 'ماکائو قرمز' },
      { value: 'scarlet', label: 'ماکائو اسکارلت' },
      { value: 'hahns', label: 'ماکائو هانس' },
      { value: 'harlequin', label: 'ماکائو هارلی کویین' },
    ],
  },
  {
    value: 'cockatoo',
    label: 'کاکادو',
    subspecies: [
      { value: 'sulphur-crested', label: 'کاکادو تاج زرد (باراتا)' },
      { value: 'umbrella', label: 'کاکادو آمبرلا' },
      { value: 'moluccan', label: 'کاکادو مولوکان' },
      { value: 'goffin', label: 'کاکادو گوفین' },
      { value: 'bare-eyed', label: 'کاکادو چشم برهنه' },
      { value: 'ducorps', label: 'کاکادو دوکروپ' },
      { value: 'major-mitchell', label: 'کاکادو ماژورمیشل' },
      { value: 'galah', label: 'کاکادو گالارز' },
    ],
  },
  {
    value: 'african-grey',
    label: 'کاسکو',
    subspecies: [
      { value: 'red-tail', label: 'دم قرمز (کنگو)' },
      { value: 'chocolate-tail', label: 'دم شکلاتی (تیمنه)' },
    ],
  },
  {
    value: 'green-cheek',
    label: 'گرین چیک',
    subspecies: [
      { value: 'normal', label: 'گرین‌چیک نرمال' },
      { value: 'ananasi-red', label: 'گرین‌چیک آناناسی رد' },
      { value: 'double-red', label: 'گرین‌چیک دبل رد' },
      { value: 'extreme-red', label: 'گرین‌چیک اکستریم رد' },
      { value: 'yellow-side-red', label: 'گرین‌چیک یلوساید رد' },
      {
        value: 'yellow-side-double-red',
        label: 'گرین‌چیک یلوساید دبل رد',
      },
      {
        value: 'yellow-side-extreme-red',
        label: 'گرین‌چیک یلوساید اکستریم رد',
      },
      { value: 'mint', label: 'گرین‌چیک مینت' },
      { value: 'moon-cheek', label: 'گرین‌چیک مونچیک' },
      { value: 'sun-cheek', label: 'گرین‌چیک سانچیک' },
      { value: 'ro-cheek', label: 'گرین‌چیک روچیک' },
      { value: 'pineapple', label: 'گرین‌چیک پاین‌اپل' },
      { value: 'turquoise', label: 'گرین‌چیک تراکوئیس' },
      { value: 'pied', label: 'گرین‌چیک پاید' },
      { value: 'american-dilute', label: 'گرین‌چیک امریکن دایلوت' },
      { value: 'violet', label: 'گرین‌چیک ویولت' },
    ],
  },
  {
    value: 'quaker',
    label: 'راهب',
    subspecies: [
      { value: 'blue', label: 'راهب آبی' },
      { value: 'green', label: 'راهب سبز' },
      { value: 'pistachio', label: 'راهب پسته‌ای' },
      { value: 'yellow', label: 'راهب زرد' },
      { value: 'white', label: 'راهب سفید' },
      { value: 'split', label: 'راهب اسپیلت' },
      { value: 'turquoise', label: 'راهب تراکوئیس' },
      { value: 'blue-sky', label: 'راهب بلواسکای' },
      { value: 'cross', label: 'راهب کراس' },
      { value: 'violet', label: 'راهب بنفش' },
      { value: 'gray', label: 'راهب خاکستری' },
    ],
  },
  { value: 'alexandrine', label: 'شاه طوطی' },
  { value: 'senegal', label: 'سنگال' },
  { value: 'rose-ringed', label: 'ملنگو' },
  {
    value: 'sun-conure',
    label: 'خورشیدی',
    subspecies: [
      { value: 'sun-conure', label: 'سان کانور' },
      { value: 'jenday-conure', label: 'ژاندی کانور' },
      { value: 'nanday-conure', label: 'ناندی کانور' },
    ],
  },
  {
    value: 'rosella',
    label: 'رزیلا',
    subspecies: [
      { value: 'rosella', label: 'رزیلا' },
      { value: 'shakila', label: 'شکیلا' },
    ],
  },
  {
    value: 'eclectus',
    label: 'اکلکتوس',
    subspecies: [
      { value: 'salmon', label: 'سالمون' },
      { value: 'vosmaeri', label: 'وسماری' },
    ],
  },
  {
    value: 'lorikeet',
    label: 'لوری‌کیت',
    subspecies: [
      { value: 'black', label: 'لوریکیت بلک' },
      { value: 'rainbow', label: 'لوریکیت رنگین‌کمانی' },
      { value: 'black-capped', label: 'لوریکیت بلک کپد' },
      { value: 'red', label: 'لوریکیت رد' },
      { value: 'blue-strong', label: 'لوریکیت بلو استرانگ' },
      { value: 'perfect', label: 'لوریکیت پرفکت' },
      { value: 'yellow-collar', label: 'لوری یقه زرد' },
      { value: 'green-naped', label: 'لوری پالتو سبز' },
    ],
  },
  { value: 'cockatiel', label: 'عروس هلندی' },
  {
    value: 'lovebird',
    label: 'کوتوله برزیلی',
    subspecies: [
      { value: 'fischer', label: 'فیشر' },
      { value: 'rosy-faced', label: 'رزیکولیس' },
    ],
  },
];

export const BIRD_PASSPORT_TAXONOMY = buildCanonicalTaxonomy(
  WEBSITE_PARROT_SPECIES,
);

function buildCanonicalTaxonomy(
  speciesRows: readonly WebsiteSpecies[],
): readonly BirdPassportTaxonomyItem[] {
  const speciesValues = new Set<string>();
  return Object.freeze(
    speciesRows.map((species) => {
      assertUniqueOption(species, speciesValues, 'species');
      const sourceSubspecies = species.subspecies?.length
        ? species.subspecies
        : [{ value: species.value, label: species.label }];
      const subspeciesValues = new Set<string>();
      const subspecies = sourceSubspecies.map((option) => {
        assertUniqueOption(option, subspeciesValues, 'subspecies');
        return Object.freeze({ ...option });
      });
      return Object.freeze({
        ...species,
        subspecies: Object.freeze(subspecies),
      });
    }),
  );
}

function assertUniqueOption(
  option: BirdPassportTaxonomyOption,
  values: Set<string>,
  level: string,
): void {
  if (!option.value || option.value !== option.value.trim()) {
    throw new Error(`Bird Passport taxonomy ${level} value is invalid`);
  }
  if (!option.label || option.label !== option.label.trim()) {
    throw new Error(`Bird Passport taxonomy ${level} label is invalid`);
  }
  if (values.has(option.value)) {
    throw new Error(`Duplicate Bird Passport taxonomy ${level} value`);
  }
  values.add(option.value);
}
