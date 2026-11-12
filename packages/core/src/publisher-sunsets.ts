export interface PublisherSunset {
  vendor: string;
  id: string;
  subject: string;
  recordedOn: string;
  sunset: string;
  source: string;
}

const openai = 'https://developers.openai.com/api/docs/deprecations';
const notices: readonly PublisherSunset[] = [
  {
    vendor: 'amazonaws-com-lambda',
    id: 'nodejs20-create-block',
    subject: 'AWS Lambda blocks creation of functions using the Node.js 20 runtime',
    recordedOn: '2026-11-12',
    sunset: '2027-07-29',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html',
  },
  {
    vendor: 'amazonaws-com-lambda',
    id: 'nodejs20-update-block',
    subject: 'AWS Lambda blocks updates to functions using the Node.js 20 runtime',
    recordedOn: '2026-11-12',
    sunset: '2027-08-31',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html',
  },
  {
    vendor: 'amazonaws-com-workmail',
    id: 'service-end-of-support',
    subject: 'Amazon WorkMail end of support',
    recordedOn: '2026-03-31',
    sunset: '2027-03-31',
    source: 'https://docs.aws.amazon.com/general/latest/gr/sunset_services.html',
  },
  {
    vendor: 'amazonaws-com-sns',
    id: 'china-email-subscriptions',
    subject: 'Amazon SNS email subscriptions in the China Regions end of support',
    recordedOn: '2026-06-30',
    sunset: '2027-06-30',
    source: 'https://docs.aws.amazon.com/general/latest/gr/sunset_services.html',
  },
  {
    vendor: 'anthropic',
    id: 'claude-sonnet-4-5-20250929',
    subject: 'Claude Sonnet 4.5 (claude-sonnet-4-5-20250929)',
    recordedOn: '2026-09-30',
    sunset: '2026-11-30',
    source: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
  },
  {
    vendor: 'openai',
    id: 'reusable-prompts',
    subject: 'Reusable prompt objects and /v1/prompts',
    recordedOn: '2026-06-03',
    sunset: '2026-11-30',
    source: openai + '#2026-06-03-reusable-prompts',
  },
  {
    vendor: 'openai',
    id: 'older-gpt-5-and-o3',
    subject: 'Listed older GPT-5 and o3 model snapshots',
    recordedOn: '2026-06-11',
    sunset: '2026-12-11',
    source: openai + '#2026-06-11-gpt-5-and-o3-model-deprecations',
  },
  {
    vendor: 'openai',
    id: 'legacy-audio-and-realtime',
    subject: 'Listed legacy audio, realtime and transcription models',
    recordedOn: '2026-07-20',
    sunset: '2027-01-20',
    source: openai + '#2026-07-20-legacy-audio-realtime-and-transcription-models',
  },
  {
    vendor: 'openai',
    id: 'transcription-and-translations',
    subject: 'Listed transcription models and /v1/audio/translations',
    recordedOn: '2026-08-26',
    sunset: '2027-02-26',
    source: openai + '#2026-08-26-transcription-models',
  },
];

export function publisherSunsets(vendor: string, now = new Date()) {
  const earliest = new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  return notices.filter(
    (notice) => notice.vendor === vendor && notice.recordedOn <= today && notice.sunset >= earliest,
  );
}
