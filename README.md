# ParityDiff contract diff Action

Compare up to eight contract roots in a GitHub.com pull request. The Action
supports OpenAPI (including Swagger 2), GraphQL SDL, gRPC protobuf, AsyncAPI,
and SOAP WSDL. It uses ParityDiff's deterministic parsers, comparison engine
and classification rules. It needs a Linux runner with Docker and uses a
digest-pinned comparison container with its network disabled.

The Action reads the pull request's exact base and head Git objects through
GitHub. Configure contract paths in the workflow. Relative imports and
references resolve inside their own revision. External references, missing
dependencies, invalid contracts and ambiguous findings produce an incomplete
result. It does not execute code or install dependencies from the pull request.

## Read-only checks

Use a pinned commit of the published Action. The namespace below is the intended
release location. Use a real published commit SHA before enabling the workflow.

```yaml
name: API contracts
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read
jobs:
  contracts:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: Paritydiff-Parity-Diff/contract-diff-action@bb5ff48f769ae73f34e28a833c1ea506c3fdab03
        with:
          token: ${{ github.token }}
          comment: 'false'
          fail-on-breaking: 'true'
          contracts: |
            [
              {"path":"contracts/openapi.yaml","standard":"openapi"},
              {"path":"contracts/schema.graphql","standard":"graphql"},
              {"path":"contracts/service.proto","standard":"grpc"},
              {"path":"contracts/events.yaml","standard":"asyncapi"},
              {"path":"contracts/service.wsdl","standard":"soap"}
            ]
```

The job summary reports classified findings and incomplete coverage. Removed
contract roots count as breaking. An optional gate fails the job for either
breaking or incomplete results. A clean result covers the configured contracts.
Repository call-site mapping and runtime checks are separate.

GraphQL contracts can include a `graphqlOperations` array with up to 12
self-contained query documents and their fragments. The Action reads those
queries from the base commit and validates each against both schemas. A query
that becomes invalid counts as breaking. A missing or invalid baseline query
makes the result incomplete. Resolver errors and live HTTP behavior still
require execution evidence.

The native checks cover GraphQL schema rules, protobuf field numbers and gRPC
streaming modes, and SOAP actions and envelopes. For SOAP, the Action installs
the repository's hash-pinned XSD validator and compiles the embedded schemas.
Payload compatibility and behavior not established by the static comparison
remain visible in the report.

## Pull request comments

For a trusted base-branch workflow that comments on pull requests, configure
`pull_request_target`, grant `pull-requests: write`, and set `comment: 'true'`.
Set the workflow concurrency group to the pull request number and cancel prior
runs. Keep the Action pinned and use it as shown above without a checkout step.
GitHub event policies may require an explicit opt-in for this trigger. Use the
read-only workflow if your policy disallows it.
[GitHub's pull request target guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

The Action updates its marked Actions bot comment. It rechecks the base and
head revisions before writing and skips stale results. Fetch, parse and compare
are bounded. The comment contains operation paths, classification rules and
counts. It omits contract bodies, raw schema examples and engine diagnostics.

## Build the standalone release

From the ParityDiff source checkout:

```text
node tools/contract-diff-action/prepare-standalone.mjs --output tmp/contract-diff-release
```

This exports the Action, its Apache-2.0 license and the locked engine sources.
In the exported directory run `pnpm install --frozen-lockfile --ignore-scripts`
and `pnpm exec vitest run --config tools/contract-diff-action/standalone-vitest.config.ts`.
Set `RUN_CONTRACT_DIFF_DOCKER=1` to test all five formats through the pinned
container. The package includes a GitHub test workflow with that setting.
