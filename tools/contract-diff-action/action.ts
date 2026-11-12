import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureXsdParser } from '../../packages/detect/src/xsd-validation';
import { compareContract, parseContracts, type ContractReport } from './compare';
import { commentMarker, GitHubContracts, isRepository, sameRevision } from './github';

function literal(value: string) {
  const oneLine = value.slice(0, 120).replace(/[\r\n]/g, ' ');
  return (
    '<code>' +
    oneLine.replace(
      /[&<>"@|]/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          '@': '&#64;',
          '|': '&#124;',
        })[character]!,
    ) +
    '</code>'
  );
}

export function reportMarkdown(base: string, head: string, reports: readonly ContractReport[]) {
  const sections = reports.map((report) => {
    const { counts } = report;
    const results = [
      report.state + '.',
      counts.breaking +
        ' breaking, ' +
        counts.non_breaking +
        ' non-breaking, ' +
        counts.ambiguous +
        ' ambiguous, ' +
        counts.deprecation +
        ' deprecations.',
      ...(report.reason ? [report.reason + '.'] : []),
    ].join(' ');
    const findings = report.findings
      .slice(0, 6)
      .map(
        (finding) =>
          '- ' +
          finding.classification +
          ': ' +
          literal([finding.method, finding.path].filter(Boolean).join(' ') || report.path) +
          ' (' +
          literal(finding.rule) +
          ')',
      );
    const total = counts.breaking + counts.ambiguous + counts.deprecation;
    if (total > findings.length)
      findings.push('- ' + (total - findings.length) + ' additional findings.');
    return [
      '### ' + report.standard + ' ' + literal(report.path),
      '',
      results,
      '',
      ...findings,
      ...(report.runtimeNotes?.length
        ? ['', ...report.runtimeNotes.map((note) => '- Runtime evidence: ' + note + '.')]
        : []),
      '',
    ].join('\n');
  });
  return [
    commentMarker,
    '## ParityDiff contract changes',
    '',
    'Base ' + literal(base) + ' and head ' + literal(head) + '.',
    '',
    ...sections,
    'Coverage: configured contract files and their available Git references. Repository call-site and runtime checks are separate.',
    '',
  ].join('\n');
}

function boolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  if (value !== 'true' && value !== 'false') throw new Error('Boolean input must be true or false');
  return value === 'true';
}

export async function runAction(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch) {
  const event = env['GITHUB_EVENT_NAME'];
  if (event !== 'pull_request' && event !== 'pull_request_target')
    throw new Error('Run the Action on a pull request event');
  const repository = env['GITHUB_REPOSITORY'];
  if (
    !isRepository(repository) ||
    !env['GITHUB_EVENT_PATH'] ||
    (env['GITHUB_API_URL'] && env['GITHUB_API_URL'] !== 'https://api.github.com')
  )
    throw new Error('A GitHub.com pull request is required');
  const payload = JSON.parse(await readFile(env['GITHUB_EVENT_PATH'], 'utf8')) as {
    number?: number;
    pull_request?: { head?: { sha?: string }; base?: { sha?: string } };
  };
  const number = payload.number;
  if (!number || !Number.isSafeInteger(number) || number < 1 || !payload.pull_request)
    throw new Error('Pull request identity is missing');
  const contracts = parseContracts(env['CONTRACT_DIFF_FILES'] ?? '');
  if (contracts.some((contract) => contract.standard === 'soap') && env['XSD_PYTHON_BIN'])
    configureXsdParser(env['XSD_PYTHON_BIN']);
  const comment = boolean(env['CONTRACT_DIFF_COMMENT'], true);
  const gate = boolean(env['CONTRACT_DIFF_GATE'], false);
  const github = new GitHubContracts(env['CONTRACT_DIFF_TOKEN'] ?? '', fetcher);
  const pull = await github.pull(repository, number);
  if (
    pull.head.sha !== payload.pull_request.head?.sha ||
    pull.base.sha !== payload.pull_request.base?.sha
  ) {
    return { status: 'stale', breaking: 0, incomplete: 0, exitCode: 0 };
  }
  const base = github.reader(pull.base);
  const head = github.reader(pull.head);
  const reports: ContractReport[] = [];
  for (const contract of contracts) reports.push(await compareContract(contract, base, head));
  const markdown = reportMarkdown(pull.base.sha, pull.head.sha, reports);
  const breaking = reports.reduce((total, report) => total + report.counts.breaking, 0);
  const incomplete = reports.filter((report) => report.state === 'incomplete').length;
  const status = comment
    ? await github.publish(repository, pull, markdown)
    : sameRevision(await github.pull(repository, number), pull)
      ? 'summary'
      : 'stale';
  if (status === 'stale') return { status, breaking: 0, incomplete: 0, exitCode: 0 };
  if (env['GITHUB_STEP_SUMMARY']) await appendFile(env['GITHUB_STEP_SUMMARY'], markdown);
  return {
    status,
    breaking,
    incomplete,
    exitCode: gate && (breaking > 0 || incomplete > 0) ? 1 : 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = { ...process.env };
  delete process.env['CONTRACT_DIFF_TOKEN'];
  try {
    const result = await runAction(env);
    if (env['GITHUB_OUTPUT'])
      await appendFile(
        env['GITHUB_OUTPUT'],
        'status=' +
          result.status +
          '\nbreaking=' +
          result.breaking +
          '\nincomplete=' +
          result.incomplete +
          '\n',
      );
    console.log('ParityDiff contract diff: ' + result.status + '.');
    process.exitCode = result.exitCode;
  } catch (error) {
    const safe =
      error instanceof Error
        ? error.message.replace(/[\r\n]/g, ' ').slice(0, 240)
        : 'unexpected error';
    console.error('ParityDiff contract diff: ' + safe);
    process.exitCode = 1;
  }
}
