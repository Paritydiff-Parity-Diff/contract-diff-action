export const FEATURED_PUBLIC_API_IDS = [
  'openai',
  'anthropic',
  'stripe',
  'sentry',
  'digitalocean',
  'mistral',
  'cohere',
  'pinecone',
] as const;

export const PUBLIC_API_METADATA: Record<
  string,
  { category: string; description: string; documentationUrl?: string }
> = {
  digitalocean: {
    category: 'Cloud infrastructure',
    description: 'Droplets, Kubernetes, databases, and networking.',
  },
  asana: {
    category: 'Work management',
    description: 'Tasks, projects, portfolios, and workspaces.',
  },
  pagerduty: {
    category: 'Incident management',
    description: 'Incidents, on-call schedules, and escalation policies.',
  },
  box: {
    category: 'Content management',
    description: 'Files, folders, collaborations, and webhooks.',
  },
  netlify: {
    category: 'Web infrastructure',
    description: 'Sites, builds, deploys, and edge functions.',
  },
  square: {
    category: 'Commerce',
    description: 'Payments, orders, catalog, and customer APIs.',
  },
  mistral: {
    category: 'Language models',
    description: 'Chat, embeddings, and model capabilities.',
    documentationUrl: 'https://docs.mistral.ai/api/',
  },
  cohere: {
    category: 'Language models',
    description: 'Chat, retrieval, embeddings, and reranking.',
    documentationUrl: 'https://docs.cohere.com/reference/about',
  },
  sentry: {
    category: 'Observability',
    description: 'Organizations, projects, issues, and releases.',
    documentationUrl: 'https://docs.sentry.io/api/',
  },
  'cal-com': {
    category: 'Scheduling',
    description: 'Bookings, event types, and availability.',
    documentationUrl: 'https://cal.com/docs/api-reference/v2/introduction',
  },
  openai: {
    category: 'Language models',
    description: 'Responses, models, embeddings, and media APIs.',
    documentationUrl: 'https://developers.openai.com/api/reference/overview',
  },
};
