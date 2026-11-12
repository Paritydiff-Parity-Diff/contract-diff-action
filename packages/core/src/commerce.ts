import { AI_PLAN_CREDITS, PLAN_LIMITS } from './plans';

export const COMMERCE_REVISION = 2;
export type CommerceInterval = 'month' | 'year' | 'once';
type Category =
  | 'consumer_plan'
  | 'consumer_addon'
  | 'credit_pack'
  | 'release_pass'
  | 'provider_plan'
  | 'provider_pilot'
  | 'provider_campaign'
  | 'evaluation';
interface Offering {
  name: string;
  category: Category;
  salesOnly?: boolean;
  prices: Partial<Record<CommerceInterval, number>>;
  monthlyCredits?: number;
  annualBonusCredits?: number;
  credits?: number;
  termDays?: number;
  providerApis?: number;
  sponsoredWorkspaces?: number;
  extraRepos?: number;
  extraApis?: number;
  sandboxRunsMonthly?: number;
  privateMcpSeats?: number;
}

export const COMMERCE_OFFERINGS = {
  pro: {
    name: 'Pro',
    category: 'consumer_plan',
    prices: { month: 8000, year: 80000 },
    monthlyCredits: AI_PLAN_CREDITS.pro,
    annualBonusCredits: 300,
  },
  pro_founding: {
    name: 'Founding Pro',
    category: 'consumer_plan',
    prices: { month: 6000, year: 60000 },
    monthlyCredits: AI_PLAN_CREDITS.pro,
    annualBonusCredits: 300,
  },
  advanced: {
    name: 'Advanced',
    category: 'consumer_plan',
    prices: { month: 25000, year: 250000 },
    monthlyCredits: AI_PLAN_CREDITS.advanced,
    annualBonusCredits: 1000,
    privateMcpSeats: 10,
  },
  footprint: {
    name: 'Footprint',
    category: 'consumer_addon',
    prices: { month: 5000, year: 50000 },
    extraRepos: 15,
    extraApis: 10,
  },
  sandbox: {
    name: 'Runtime Sandbox',
    category: 'consumer_addon',
    prices: { month: 4000, year: 40000 },
    sandboxRunsMonthly: 40,
  },
  guardrail: {
    name: 'AI-Native Coding Guardrail',
    category: 'consumer_addon',
    prices: { month: 4000, year: 40000 },
    credits: 150,
    privateMcpSeats: 5,
  },
  credit_pack_150: {
    name: '150 carry-over credits',
    category: 'credit_pack',
    prices: { once: 4000 },
    credits: 150,
  },
  credit_pack_450: {
    name: '450 carry-over credits',
    category: 'credit_pack',
    prices: { once: 10000 },
    credits: 450,
  },
  release_pass: {
    name: '7-Day Single Release Pass',
    category: 'release_pass',
    prices: { once: 5000 },
    credits: 50,
    termDays: 7,
  },
  provider_pilot: {
    name: 'Provider Release Pilot',
    category: 'provider_pilot',
    prices: { once: 50000 },
    credits: 250,
    termDays: 30,
    providerApis: 1,
  },
  provider_growth: {
    name: 'Provider Growth',
    category: 'provider_plan',
    prices: { month: 50000, year: 500000 },
    monthlyCredits: 5000,
    providerApis: 1,
    sponsoredWorkspaces: 100,
  },
  provider_scale: {
    name: 'Provider Scale',
    category: 'provider_plan',
    salesOnly: true,
    prices: {},
  },
  sunset_campaign: {
    name: 'Provider Sunset Campaign',
    category: 'provider_campaign',
    prices: { once: 250000 },
    credits: 5000,
    termDays: 90,
    providerApis: 1,
    sponsoredWorkspaces: 100,
  },
  scoped_evaluation: {
    name: 'Scoped Evaluation',
    category: 'evaluation',
    salesOnly: true,
    prices: { once: 150000 },
  },
} as const satisfies Record<string, Offering>;

export type CommerceSku = keyof typeof COMMERCE_OFFERINGS;
export interface CommerceItem {
  sku: CommerceSku;
  interval: CommerceInterval;
  quantity: number;
}
export interface ConsumerEntitlements {
  plan: 'pro' | 'advanced';
  limits: { repos: number; vendors: number; seats: number; draftPr: boolean };
  monthlyCredits: number;
  annualBonusCredits: number;
  activationBonusCredits: number;
  sandboxRunsMonthly: number;
  privateMcpSeats: number;
  consumerCiGuardrail: boolean;
  crossRepoGates: boolean;
  orgPolicies: boolean;
}
const fail = (code: string) => Object.assign(new Error(code), { statusCode: 400 });

export function commerceOffering(sku: string): Offering {
  if (!Object.hasOwn(COMMERCE_OFFERINGS, sku)) throw fail('unknown_commerce_product');
  return COMMERCE_OFFERINGS[sku as CommerceSku];
}

export function validateCommerceCart(
  items: readonly CommerceItem[],
  permissions: { founding?: boolean; salesContract?: boolean } = {},
) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 4)
    throw fail('invalid_commerce_cart');
  const cart: readonly CommerceItem[] = items;
  const seen = new Set<string>();
  for (const item of cart) {
    if (!item || typeof item !== 'object') throw fail('invalid_commerce_cart');
    const offering = commerceOffering(item.sku);
    if (seen.has(item.sku) || item.quantity !== 1) throw fail('invalid_commerce_quantity');
    seen.add(item.sku);
    if (offering.salesOnly && !permissions.salesContract) throw fail('contact_sales_required');
    if (item.sku === 'provider_scale') throw fail('sales_contract_price_required');
    if (item.sku === 'pro_founding' && !permissions.founding)
      throw fail('founding_allocation_required');
    if (!Object.hasOwn(offering.prices, item.interval)) throw fail('invalid_commerce_interval');
  }
  const plans = cart.filter((item) => commerceOffering(item.sku).category === 'consumer_plan');
  const addons = cart.filter((item) => commerceOffering(item.sku).category === 'consumer_addon');
  if (cart.length > 1 && (plans.length !== 1 || plans.length + addons.length !== cart.length))
    throw fail('incompatible_commerce_products');
  if (addons.length && !plans.length) throw fail('addon_requires_plan_subscription');
  const base = plans[0];
  if (base)
    for (const addon of addons) {
      if (addon.interval !== base.interval) throw fail('addon_interval_must_match_plan');
      if (base.sku === 'advanced' && addon.sku !== 'sandbox') throw fail('addon_is_pro_only');
    }
  const totalCents = cart.reduce(
    (sum, item) => sum + commerceOffering(item.sku).prices[item.interval]!,
    0,
  );
  return { totalCents, currency: 'USD' as const, interval: cart[0]!.interval };
}

export function consumerEntitlements(items: readonly CommerceItem[]): ConsumerEntitlements {
  validateCommerceCart(items, { founding: true });
  const base = items.find((item) => commerceOffering(item.sku).category === 'consumer_plan');
  if (!base) throw fail('consumer_plan_required');
  const plan = base.sku === 'advanced' ? 'advanced' : 'pro';
  const has = (sku: CommerceSku) => items.some((item) => item.sku === sku);
  const footprint = has('footprint');
  return {
    plan,
    limits: {
      ...PLAN_LIMITS[plan],
      repos: PLAN_LIMITS[plan].repos + (footprint ? COMMERCE_OFFERINGS.footprint.extraRepos : 0),
      vendors: PLAN_LIMITS[plan].vendors + (footprint ? COMMERCE_OFFERINGS.footprint.extraApis : 0),
    },
    monthlyCredits: AI_PLAN_CREDITS[plan],
    annualBonusCredits:
      base.interval === 'year' ? (commerceOffering(base.sku).annualBonusCredits ?? 0) : 0,
    activationBonusCredits: has('guardrail') ? COMMERCE_OFFERINGS.guardrail.credits : 0,
    sandboxRunsMonthly: has('sandbox') ? COMMERCE_OFFERINGS.sandbox.sandboxRunsMonthly : 0,
    privateMcpSeats:
      plan === 'advanced'
        ? COMMERCE_OFFERINGS.advanced.privateMcpSeats
        : has('guardrail')
          ? COMMERCE_OFFERINGS.guardrail.privateMcpSeats
          : 0,
    consumerCiGuardrail: plan === 'advanced' || has('guardrail'),
    crossRepoGates: plan === 'advanced',
    orgPolicies: plan === 'advanced',
  };
}
