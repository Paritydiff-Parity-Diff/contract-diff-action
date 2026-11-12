import { Kind, parse, type SelectionSetNode } from 'graphql';

export function graphqlOperationPaths(query: string): readonly string[] | undefined {
  if (query.length > 65536) return undefined;
  try {
    const document = parse(query, { noLocation: true, maxTokens: 10000 });
    const fragments = new Map(
      document.definitions
        .filter((definition) => definition.kind === Kind.FRAGMENT_DEFINITION)
        .map((definition) => [definition.name.value, definition.selectionSet]),
    );
    const paths = new Set<string>();
    let nodes = 0;
    const walk = (set: SelectionSetNode, operation: string, seen: Set<string>, depth = 0): void => {
      if (depth > 32 || ++nodes > 1000) throw new Error('query binding limit');
      for (const selection of set.selections) {
        if (selection.kind === Kind.FIELD)
          paths.add('/graphql/' + operation + '/' + selection.name.value);
        else if (selection.kind === Kind.INLINE_FRAGMENT)
          walk(selection.selectionSet, operation, seen, depth + 1);
        else {
          const name = selection.name.value,
            fragment = fragments.get(name);
          if (!fragment || seen.has(name)) throw new Error('unresolved query fragment');
          walk(fragment, operation, new Set(seen).add(name), depth + 1);
        }
      }
    };
    for (const definition of document.definitions)
      if (definition.kind === Kind.OPERATION_DEFINITION)
        walk(definition.selectionSet, definition.operation, new Set());
    return paths.size ? [...paths].sort() : undefined;
  } catch {
    return undefined;
  }
}
