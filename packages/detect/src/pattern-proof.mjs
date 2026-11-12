const MAX = 0x10ffff;
const merge = (ranges) => {
  const output = [];
  for (const [low, high] of ranges.sort((a, b) => a[0] - b[0])) {
    if (output.length && low <= output.at(-1)[1] + 1)
      output.at(-1)[1] = Math.max(high, output.at(-1)[1]);
    else output.push([low, high]);
  }
  return output;
};
const inverse = (ranges) => {
  const output = [];
  let position = 0;
  for (const [low, high] of merge(ranges)) {
    if (position < low) output.push([position, low - 1]);
    position = high + 1;
  }
  if (position <= MAX) output.push([position, MAX]);
  return output;
};
const any = [[0, MAX]],
  digit = [[48, 57]],
  word = [
    [48, 57],
    [65, 90],
    [95, 95],
    [97, 122],
  ],
  space = [
    [9, 13],
    [32, 32],
    [160, 160],
    [0x1680, 0x1680],
    [0x2000, 0x200a],
    [0x2028, 0x2029],
    [0x202f, 0x202f],
    [0x205f, 0x205f],
    [0x3000, 0x3000],
    [0xfeff, 0xfeff],
  ];
const unicodeProperties = new Map();
const wordPoint = (point) => word.some(([low, high]) => point >= low && point <= high);
const alphabetStart = [0, 0xd800, 0xdc00, 0xe000, 48, 58, 65, 91, 95, 96, 97, 123];
function unicodeProperty(name) {
  if (unicodeProperties.has(name)) return unicodeProperties.get(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z0-9_]+)?$/.test(name))
    throw new Error('pattern_proof_unicode_property_invalid');
  const regex = new RegExp('^\\p{' + name + '}$', 'u');
  const ranges = [];
  for (let point = 0; point <= MAX; point++) {
    if (!regex.test(String.fromCodePoint(point))) continue;
    if (ranges.length && ranges.at(-1)[1] === point - 1) ranges.at(-1)[1] = point;
    else ranges.push([point, point]);
    if (ranges.length > 512) throw new Error('pattern_proof_unicode_property_limit');
  }
  if (unicodeProperties.size >= 8) unicodeProperties.delete(unicodeProperties.keys().next().value);
  unicodeProperties.set(name, ranges);
  return ranges;
}
function parse(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 2048) throw new Error('pattern_proof_limit');
  new RegExp(pattern, 'u');
  let position = 0;
  const character = (inClass) => {
    const value = pattern.codePointAt(position);
    if (value === undefined) throw new Error('pattern_proof_invalid');
    position += value > 0xffff ? 2 : 1;
    if (value !== 92) return [[value, value]];
    const escaped = pattern[position++],
      classes = { d: digit, w: word, s: space };
    if (escaped === 'p' || escaped === 'P') {
      if (pattern[position++] !== '{') throw new Error('pattern_proof_invalid');
      const close = pattern.indexOf('}', position);
      if (close < 0) throw new Error('pattern_proof_invalid');
      const ranges = unicodeProperty(pattern.slice(position, close));
      position = close + 1;
      return escaped === 'p' ? ranges : inverse(ranges);
    }
    if (classes[escaped?.toLowerCase()])
      return escaped === escaped.toLowerCase()
        ? classes[escaped]
        : inverse(classes[escaped.toLowerCase()]);
    const control = { n: 10, r: 13, t: 9, f: 12, v: 11, ...(inClass ? { b: 8 } : {}) };
    if (control[escaped] !== undefined) return [[control[escaped], control[escaped]]];
    if (escaped === 'x' || escaped === 'u') {
      let text;
      const braced = escaped === 'u' && pattern[position] === '{';
      if (escaped === 'u' && pattern[position] === '{') {
        const close = pattern.indexOf('}', ++position);
        if (close < 0) throw new Error('pattern_proof_invalid');
        text = pattern.slice(position, close);
        position = close + 1;
      } else {
        const length = escaped === 'x' ? 2 : 4;
        text = pattern.slice(position, position + length);
        position += length;
      }
      if (!/^[0-9a-f]+$/i.test(text)) throw new Error('pattern_proof_invalid');
      let code = parseInt(text, 16);
      if (code > MAX) throw new Error('pattern_proof_invalid');
      if (!braced && code >= 0xd800 && code <= 0xdbff) {
        const pair = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(pattern.slice(position));
        if (pair) {
          code = 0x10000 + (code - 0xd800) * 1024 + parseInt(pair[1], 16) - 0xdc00;
          position += pair[0].length;
        }
      }
      return [[code, code]];
    }
    if (!escaped || !'^$\\.*+?()[]{}|/-'.includes(escaped))
      throw new Error('pattern_proof_escape_unavailable');
    return [[escaped.codePointAt(0), escaped.codePointAt(0)]];
  };
  const expression = (depth = 0) => {
    if (depth > 16) throw new Error('pattern_proof_limit');
    const choices = [],
      sequence = [];
    while (position < pattern.length && pattern[position] !== ')') {
      if (pattern[position] === '|') {
        choices.push({ kind: 'sequence', children: sequence.splice(0) });
        position++;
        continue;
      }
      let item;
      if (pattern[position] === '\\' && ['b', 'B'].includes(pattern[position + 1])) {
        item = { kind: 'assertion', boundary: pattern[position + 1] === 'b' ? 'word' : 'nonword' };
        position += 2;
      } else if (pattern[position] === '^' || pattern[position] === '$') {
        item = { kind: 'assertion', boundary: pattern[position++] === '^' ? 'start' : 'end' };
      } else if (pattern[position] === '(') {
        position++;
        let lookahead;
        if (pattern.slice(position, position + 2) === '?:') position += 2;
        else if (['?=', '?!'].includes(pattern.slice(position, position + 2))) {
          lookahead = pattern[position + 1] === '!';
          position += 2;
        } else if (pattern[position] === '?')
          throw new Error('pattern_proof_assertion_unavailable');
        item = expression(depth + 1);
        if (pattern[position++] !== ')') throw new Error('pattern_proof_invalid');
        if (lookahead !== undefined) item = { kind: 'lookahead', negative: lookahead, child: item };
      } else if (pattern[position] === '[') {
        position++;
        const negate = pattern[position] === '^';
        if (negate) position++;
        const ranges = [];
        while (position < pattern.length && pattern[position] !== ']') {
          const left = character(true);
          if (pattern[position] === '-' && pattern[position + 1] !== ']') {
            position++;
            const right = character(true);
            if (
              left.length !== 1 ||
              right.length !== 1 ||
              left[0][0] !== left[0][1] ||
              right[0][0] !== right[0][1] ||
              left[0][0] > right[0][0]
            )
              throw new Error('pattern_proof_range_unavailable');
            ranges.push([left[0][0], right[0][0]]);
          } else ranges.push(...left);
        }
        if (pattern[position++] !== ']') throw new Error('pattern_proof_invalid');
        item = { kind: 'character', ranges: negate ? inverse(ranges) : merge(ranges) };
      } else if (pattern[position] === '.') {
        position++;
        item = {
          kind: 'character',
          ranges: inverse([
            [10, 10],
            [13, 13],
            [0x2028, 0x2029],
          ]),
        };
      } else {
        if ('^$*+?{}]'.includes(pattern[position]))
          throw new Error('pattern_proof_assertion_unavailable');
        item = { kind: 'character', ranges: character(false) };
      }
      let low = 1,
        high = 1;
      if ('*+?'.includes(pattern[position] ?? '\0')) {
        const quantifier = pattern[position++];
        low = quantifier === '+' ? 1 : 0;
        high = quantifier === '?' ? 1 : Infinity;
      } else if (pattern[position] === '{') {
        const matched = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(pattern.slice(position));
        if (!matched) throw new Error('pattern_proof_invalid');
        position += matched[0].length;
        low = Number(matched[1]);
        high = matched[2] === undefined ? low : matched[2] === '' ? Infinity : Number(matched[2]);
      }
      if (low > 128 || (high !== Infinity && (high > 128 || high < low)))
        throw new Error('pattern_proof_limit');
      if (pattern[position] === '?') position++;
      sequence.push(low === 1 && high === 1 ? item : { kind: 'repeat', child: item, low, high });
    }
    choices.push({ kind: 'sequence', children: sequence });
    return choices.length === 1 ? choices[0] : { kind: 'choice', children: choices };
  };
  const root = expression();
  if (position !== pattern.length) throw new Error('pattern_proof_invalid');
  const wildcard = {
    kind: 'repeat',
    child: { kind: 'character', ranges: any },
    low: 0,
    high: Infinity,
  };
  return {
    kind: 'sequence',
    children: [wildcard, root, wildcard],
  };
}
function automaton(root) {
  const states = [];
  const state = () => {
    if (states.length >= 512) throw new Error('pattern_proof_limit');
    return states.push({ epsilon: [], assertions: [], edges: [] }) - 1;
  };
  const compile = (node, start, end) => {
    if (node.kind === 'assertion') {
      states[start].assertions.push({ boundary: node.boundary, to: end });
      return;
    }
    if (node.kind === 'character') {
      states[start].edges.push({ ranges: node.ranges, to: end });
      return;
    }
    if (node.kind === 'choice') {
      for (const child of node.children) {
        const a = state(),
          b = state();
        states[start].epsilon.push(a);
        compile(child, a, b);
        states[b].epsilon.push(end);
      }
      return;
    }
    if (node.kind === 'sequence') {
      let at = start;
      node.children.forEach((child, index) => {
        const next = index === node.children.length - 1 ? end : state();
        compile(child, at, next);
        at = next;
      });
      if (!node.children.length) states[start].epsilon.push(end);
      return;
    }
    if (node.kind !== 'repeat') throw new Error('pattern_proof_assertion_unavailable');
    let at = start;
    for (let index = 0; index < node.low; index++) {
      const next = state();
      compile(node.child, at, next);
      at = next;
    }
    states[at].epsilon.push(end);
    if (node.high === Infinity) {
      const next = state();
      compile(node.child, at, next);
      states[next].epsilon.push(at);
    } else
      for (let index = node.low; index < node.high; index++) {
        const next = state();
        compile(node.child, at, next);
        states[next].epsilon.push(end);
        at = next;
      }
  };
  const start = state(),
    end = state();
  compile(root, start, end);
  const closure = (input, atStart = false, atEnd = false, previousWord = false, nextWord) => {
    const found = new Set(input),
      queue = [...input];
    for (let index = 0; index < queue.length; index++)
      for (const next of [
        ...states[queue[index]].epsilon,
        ...states[queue[index]].assertions
          .filter(({ boundary }) =>
            boundary === 'start'
              ? atStart
              : boundary === 'end'
                ? atEnd
                : nextWord !== undefined &&
                  (boundary === 'word' ? previousWord !== nextWord : previousWord === nextWord),
          )
          .map(({ to }) => to),
      ])
        if (!found.has(next)) {
          found.add(next);
          queue.push(next);
        }
    return [...found].sort((a, b) => a - b);
  };
  return {
    states,
    end,
    initial: closure([start], true),
    dead: (input) => !input.length,
    accepts: (input, atStart, previousWord) =>
      closure(input, atStart, true, previousWord, false).includes(end),
    step: (input, value, atStart, previousWord) =>
      closure(
        closure(input, atStart, false, previousWord, wordPoint(value)).flatMap((id) =>
          states[id].edges
            .filter((edge) => edge.ranges.some(([low, high]) => value >= low && value <= high))
            .map((edge) => edge.to),
        ),
      ),
  };
}
function patternAutomaton(pattern) {
  const parsed = parse(pattern),
    root = parsed.children[1],
    guards = [];
  if (
    root.kind === 'sequence' &&
    root.children[0]?.kind === 'assertion' &&
    root.children[0].boundary === 'start'
  ) {
    while (root.children[1]?.kind === 'lookahead') guards.push(root.children.splice(1, 1)[0]);
  }
  const main = automaton(parsed);
  if (!guards.length) return main;
  const parts = [
    { model: main, positive: true },
    ...guards.map((guard) => ({
      model: automaton({
        kind: 'sequence',
        children: [{ kind: 'assertion', boundary: 'start' }, guard.child, parsed.children[2]],
      }),
      positive: !guard.negative,
    })),
  ];
  const states = parts.flatMap((part) => part.model.states);
  if (states.length > 512) throw new Error('pattern_proof_limit');
  return {
    states,
    initial: parts.map((part) => part.model.initial),
    accepts: (input, atStart, previousWord) =>
      parts.every(
        (part, index) => part.model.accepts(input[index], atStart, previousWord) === part.positive,
      ),
    dead: (input) => parts.some((part, index) => part.positive && part.model.dead(input[index])),
    step: (input, value, atStart, previousWord) =>
      parts.map((part, index) => part.model.step(input[index], value, atStart, previousWord)),
  };
}
function relation(before, after, minimum = 0, maximum = Infinity) {
  if (!after.length || after.every((pattern) => before.includes(pattern))) return { subset: true };
  try {
    if (
      !Number.isSafeInteger(minimum) ||
      minimum < 0 ||
      minimum > 256 ||
      (maximum !== Infinity &&
        (!Number.isSafeInteger(maximum) || maximum < minimum || maximum > 256))
    )
      return undefined;
    if (before.length + after.length > 16) return undefined;
    const models = [...before, ...after].map(patternAutomaton);
    const boundaries = new Set(alphabetStart);
    for (const model of models)
      for (const state of model.states)
        for (const edge of state.edges)
          for (const [low, high] of edge.ranges) {
            boundaries.add(low);
            if (high < MAX) boundaries.add(high + 1);
          }
    if (boundaries.size > 1024) return undefined;
    const symbols = [...boundaries],
      queue = [[models.map((model) => model.initial), '', 0, false, false]],
      seen = new Set();
    let transitions = 0;
    for (let index = 0; index < queue.length; index++) {
      if (queue.length > 4096) return undefined;
      const [states, value, length, previousHigh, previousWord] = queue[index];
      const accepted = states.map((state, index) =>
        models[index].accepts(state, value.length === 0, previousWord),
      );
      if (
        length >= minimum &&
        accepted.slice(0, before.length).every(Boolean) &&
        !accepted.slice(before.length).every(Boolean)
      )
        return { subset: false, witness: value };
      if (length === maximum) continue;
      for (const symbol of symbols) {
        if (previousHigh && symbol >= 0xdc00 && symbol <= 0xdfff) continue;
        if (++transitions > 65536 || value.length > 8192) return undefined;
        const next = states.map((state, index) =>
          models[index].step(state, symbol, value.length === 0, previousWord),
        );
        if (next.slice(0, before.length).some((state, index) => models[index].dead(state)))
          continue;
        const nextLength = maximum === Infinity ? Math.min(length + 1, minimum) : length + 1;
        const high = symbol >= 0xd800 && symbol <= 0xdbff;
        const nextWord = wordPoint(symbol);
        const key = JSON.stringify([next, nextLength, false, high, nextWord]);
        if (!seen.has(key)) {
          seen.add(key);
          queue.push([next, value + String.fromCodePoint(symbol), nextLength, high, nextWord]);
        }
      }
    }
    return { subset: true };
  } catch {
    return undefined;
  }
}
export function patternSubset(before, after) {
  return (
    relation(before === undefined ? [] : [before], after === undefined ? [] : [after])?.subset ===
    true
  );
}
export function patternWitness(before, after, minimum = 0, maximum = Infinity) {
  return relation(
    before === undefined ? [] : [before],
    after === undefined ? [] : [after],
    minimum,
    maximum,
  )?.witness;
}

export function patternIntersectionSubset(before, after, minimum = 0, maximum = Infinity) {
  return relation(before, after, minimum, maximum)?.subset === true;
}

export function propertyNamePartitions(patterns, excluded = []) {
  try {
    if (patterns.length > 16 || excluded.length > 128) return undefined;
    const models = [
      ...patterns.map(patternAutomaton),
      ...excluded.map((name) =>
        automaton({
          kind: 'sequence',
          children: [...name].map((char) => ({
            kind: 'character',
            ranges: [[char.codePointAt(0), char.codePointAt(0)]],
          })),
        }),
      ),
    ];
    if (models.reduce((sum, model) => sum + model.states.length, 0) > 8192) return undefined;
    const boundaries = new Set(alphabetStart);
    for (const model of models)
      for (const state of model.states)
        for (const edge of state.edges)
          for (const [low, high] of edge.ranges) {
            boundaries.add(low);
            if (high < MAX) boundaries.add(high + 1);
          }
    if (boundaries.size > 1024) return undefined;
    const queue = [
      {
        states: models.map((model) => model.initial),
        value: '',
        previousHigh: false,
        previousWord: false,
      },
    ];
    const seen = new Set([JSON.stringify([queue[0].states, true, false, false])]),
      partitions = new Map();
    const regexes = patterns.map((pattern) => new RegExp(pattern, 'u'));
    let transitions = 0;
    for (let position = 0; position < queue.length; position++) {
      if (queue.length > 4096) return undefined;
      const { states, value, previousHigh, previousWord } = queue[position];
      const accepted = states.map((state, index) =>
        models[index].accepts(state, value.length === 0, previousWord),
      );
      if (!accepted.slice(patterns.length).some(Boolean)) {
        const matches = accepted.slice(0, patterns.length);
        if (
          regexes.some((regex, index) => regex.test(value) !== matches[index]) ||
          excluded.includes(value)
        )
          return undefined;
        const key = JSON.stringify(matches);
        if (!partitions.has(key)) partitions.set(key, { matches, representative: value });
      }
      for (const symbol of boundaries) {
        if (previousHigh && symbol >= 0xdc00 && symbol <= 0xdfff) continue;
        if (++transitions > 65536 || value.length > 8192) return undefined;
        const next = states.map((state, index) =>
          models[index].step(state, symbol, value.length === 0, previousWord),
        );
        const high = symbol >= 0xd800 && symbol <= 0xdbff;
        const nextWord = wordPoint(symbol);
        const key = JSON.stringify([next, false, high, nextWord]);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({
          states: next,
          value: value + String.fromCodePoint(symbol),
          previousHigh: high,
          previousWord: nextWord,
        });
      }
    }
    return [...partitions.values()];
  } catch {
    return undefined;
  }
}

export function patternProofProfile() {
  return {
    implementation: 'paritydiff-ecmascript-unicode-automata-v3',
    unicodeVersion: process.versions.unicode,
    runtime: { node: process.versions.node, v8: process.versions.v8 },
    assertions: [
      'scoped_start',
      'scoped_end',
      'ascii_word_boundary',
      'ascii_nonword_boundary',
      'start_anchored_regular_lookahead',
    ],
    unicodeProperties: 'bounded_exact_native_code_point_sets',
    unavailable: ['unanchored_or_nested_lookahead', 'lookbehind', 'backreferences'],
    limits: {
      patternLength: 2048,
      states: 512,
      alphabetBoundaries: 1024,
      productStates: 4096,
      transitions: 65536,
      repetition: 128,
      unicodeRanges: 512,
    },
  };
}

export function patternProofCapability(pattern) {
  try {
    const model = patternAutomaton(pattern);
    const boundaries = new Set([0]);
    for (const state of model.states)
      for (const edge of state.edges)
        for (const [low, high] of edge.ranges) {
          boundaries.add(low);
          if (high < MAX) boundaries.add(high + 1);
        }
    if (boundaries.size > 1024) throw new Error('pattern_proof_alphabet_limit');
    return { status: 'supported', ...patternProofProfile() };
  } catch (error) {
    return {
      status: 'unavailable',
      ...patternProofProfile(),
      reason: error.message.startsWith('pattern_proof_') ? error.message : 'pattern_proof_invalid',
    };
  }
}
