// Pure-logic self-test for src/jev-step.js and src/env-keys.js. Plain node, no
// electron. Run: node scripts/jev-step-selftest.js
// Contract: docs/jev-uia/CONTRACT.md section 7, step 1.

const assert = require('node:assert/strict');
const path = require('path');

const jevStep = require(path.join(__dirname, '..', 'src', 'jev-step.js'));
const envKeys = require(path.join(__dirname, '..', 'src', 'env-keys.js'));

const {
  extractLiteralTexts, elementKey, snapshotSignature, describeElement,
  formatHistoryEntry, buildJevRequest, interpretJevAnswers, THRESHOLDS,
} = jevStep;

const OPTION_KEY_RE = /^[a-z][a-z0-9_]{0,15}$/;

let passCount = 0;
function check(name, fn) {
  fn();
  passCount++;
  console.log(`  ok - ${name}`);
}

// ── extractLiteralTexts ──────────────────────────────────────────────────
check('extractLiteralTexts: double-quoted', () => {
  assert.deepEqual(extractLiteralTexts('Type "hello world" in Notepad'), ['hello world']);
});
check('extractLiteralTexts: search verb', () => {
  assert.deepEqual(extractLiteralTexts('search for cats on youtube'), ['cats']);
});
check('extractLiteralTexts: type verb + then', () => {
  assert.deepEqual(extractLiteralTexts('type hello then press enter'), ['hello']);
});
check('extractLiteralTexts: no verb, no quotes -> empty', () => {
  assert.deepEqual(extractLiteralTexts('open the file menu and click Save'), []);
});
check('extractLiteralTexts: apostrophe not mistaken for quote', () => {
  assert.deepEqual(extractLiteralTexts("don't close it, type 'ok' in the box"), ['ok']);
});
check('extractLiteralTexts: dedup, order, max 5', () => {
  const goal = '"a" "b" "a" "c" "d" "e" "f"';
  assert.deepEqual(extractLiteralTexts(goal), ['a', 'b', 'c', 'd', 'e']);
});

// ── elementKey / describeElement / formatHistoryEntry ───────────────────
check('elementKey', () => {
  assert.equal(elementKey({ type: 'Button', name: 'Save', aid: 'SaveBtn' }), 'Button|Save|SaveBtn');
});
check('describeElement: plain button', () => {
  assert.equal(describeElement({ type: 'Button', name: 'Save' }), 'Button "Save"');
});
check('describeElement: value + toggle + selected + expand + readonly', () => {
  const d = describeElement({
    type: 'Edit', name: 'Search', value: 'cats', toggle: 'on', selected: true,
    expand: 'collapsed', readOnly: true,
  });
  assert.equal(d, 'Edit "Search" value="cats" [on] [selected] [collapsed] [readonly]');
});
check('describeElement: quote/newline sanitization', () => {
  const d = describeElement({ type: 'Button', name: 'Say "hi"\nthere' });
  assert.ok(!d.includes('\n'));
  assert.equal(d, `Button "Say 'hi' there"`);
});
check('formatHistoryEntry: outcomes', () => {
  assert.equal(formatHistoryEntry({ source: 'gemini', desc: 'pressed win', outcome: 'ok' }, 0),
    '1. [gemini] pressed win -> ok');
  assert.equal(formatHistoryEntry({ source: 'jev', desc: 'clicked Button "Save"', outcome: 'no_effect' }, 1),
    '2. [jev] clicked Button "Save" -> no visible change');
  assert.equal(formatHistoryEntry({ source: 'jev', desc: 'x', outcome: 'failed' }, 0), '1. [jev] x -> failed');
  assert.equal(formatHistoryEntry({ source: 'jev', desc: 'x', outcome: 'unknown' }, 0), '1. [jev] x -> result unknown');
});

// ── fixtures ──────────────────────────────────────────────────────────────
function makeEl(i, overrides) {
  return Object.assign({
    id: `e${i + 1}`, i, type: 'Button',
    name: `Element number ${i} with a fairly long descriptive label used to inflate state size aaaaaaaaaaaa`.slice(0, 80),
    aid: '', cls: 'Button',
    rect: [10 + i, 10, 50, 20],
    focused: false,
    pats: ['invoke'],
  }, overrides);
}

function makeBigSnapshot() {
  const elements = [];
  for (let i = 0; i < 230; i++) {
    if (i === 5) {
      elements.push(makeEl(i, { type: 'Edit', name: 'Big Edit Field', pats: ['value'], value: '', readOnly: false }));
    } else if (i === 10) {
      elements.push(makeEl(i, { type: 'CheckBox', name: 'Wrap', pats: ['toggle'], toggle: 'off' }));
    } else if (i === 220) {
      elements.push(makeEl(i, { focused: true }));
    } else {
      elements.push(makeEl(i, {}));
    }
  }
  return {
    ok: true, snapshotId: 'g0s1', ms: 100,
    hwnd: '0x1', pid: 1, process: 'test', title: 'Test Window',
    fw: 'Win32', windowRect: [0, 0, 1920, 1080],
    focused: { type: 'Button', name: elements[220].name, id: 'e221' },
    total: 230, truncated: false,
    elements,
  };
}

function makeSmallSnapshot(goalLiteralCount) {
  const elements = [
    { id: 'e1', i: 0, type: 'Edit', name: 'Text editor', aid: '', cls: 'Edit', rect: [0, 0, 100, 20], focused: true, pats: ['value'], value: '', readOnly: false },
    { id: 'e2', i: 1, type: 'Button', name: 'Save', aid: 'SaveBtn', cls: 'Button', rect: [0, 30, 50, 20], focused: false, pats: ['invoke'] },
    { id: 'e3', i: 2, type: 'CheckBox', name: 'Wrap', aid: '', cls: 'CheckBox', rect: [0, 60, 50, 20], focused: false, pats: ['toggle'], toggle: 'off' },
  ];
  return {
    ok: true, snapshotId: 'g0s2', ms: 50,
    hwnd: '0x2', pid: 2, process: 'notepad', title: 'Untitled - Notepad',
    fw: 'Win32', windowRect: [0, 0, 800, 600],
    focused: { type: 'Edit', name: 'Text editor', id: 'e1' },
    total: elements.length, truncated: false,
    elements,
  };
}

// ── buildJevRequest: option keys, caps, focused-kept, t_e*/text gating ──
check('buildJevRequest: big snapshot trims but keeps focused element', () => {
  const built = buildJevRequest(makeBigSnapshot(), { goal: 'click something', history: [], excludeKeys: [], executedCount: 0 });
  assert.ok('e221' in built.optionMap, 'focused element e221 must survive trimming');
  assert.ok(Object.keys(built.optionMap).length <= 255, 'option count must stay <= 255');
  assert.ok('need_vision' in built.optionMap && 'done' in built.optionMap);
  for (const k of Object.keys(built.optionMap)) assert.ok(OPTION_KEY_RE.test(k), `bad option key: ${k}`);
  assert.ok(built.state.includes('e221 '), 'state text must still list the focused element');
});

check('buildJevRequest: no literals -> no t_e* options, no text question', () => {
  const built = buildJevRequest(makeSmallSnapshot(), { goal: 'click Save', history: [], excludeKeys: [], executedCount: 0 });
  assert.equal(built.literals.length, 0);
  assert.ok(!Object.keys(built.optionMap).some(k => k.startsWith('t_')));
  assert.ok(!('text' in built.questions));
});

check('buildJevRequest: 1 literal -> t_e1 present, text question absent', () => {
  const built = buildJevRequest(makeSmallSnapshot(), { goal: 'Type "hello world" in Notepad', history: [], excludeKeys: [], executedCount: 0 });
  assert.deepEqual(built.literals, ['hello world']);
  assert.ok('t_e1' in built.optionMap);
  assert.ok(!('text' in built.questions));
});

check('buildJevRequest: 2 literals -> text question present with x1/x2/x0', () => {
  const built = buildJevRequest(makeSmallSnapshot(), { goal: 'Type "hello" then type "world"', history: [], excludeKeys: [], executedCount: 0 });
  assert.deepEqual(built.literals, ['hello', 'world']);
  assert.ok('text' in built.questions);
  assert.deepEqual(built.questions.text.criteria.x1, 'hello');
  assert.deepEqual(built.questions.text.criteria.x2, 'world');
  assert.ok('x0' in built.questions.text.criteria);
});

check('buildJevRequest: excludeKeys removes click/type options', () => {
  const built = buildJevRequest(makeSmallSnapshot(), {
    goal: 'click Save', history: [], excludeKeys: ['Button|Save|SaveBtn'], executedCount: 0,
  });
  assert.ok(!('e2' in built.optionMap));
});

// ── interpretJevAnswers: rules 1-8 ───────────────────────────────────────
const fakeBuilt = {
  optionMap: {
    e1: { kind: 'click', elementId: 'e1', el: { type: 'Button', name: 'Save', aid: '' } },
    key_enter: { kind: 'key', key: 'enter' },
    key_escape: { kind: 'key', key: 'escape' },
    scroll_down: { kind: 'scroll', direction: 'down' },
    scroll_up: { kind: 'scroll', direction: 'up' },
    done: { kind: 'done' },
    need_vision: { kind: 'need_vision' },
  },
  literals: [],
};

function assertAlwaysFilled(d) {
  assert.ok('choice' in d && 'conf' in d && 'goal' in d && 'stuck' in d && 'top2' in d);
}

check('interpretJevAnswers rule 1: missing action -> bad_answer', () => {
  const d = interpretJevAnswers({ goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 } }, fakeBuilt, { executedCount: 0 });
  assert.equal(d.kind, 'vision'); assert.equal(d.reason, 'bad_answer'); assertAlwaysFilled(d);
});
check('interpretJevAnswers rule 1: choice not in optionMap -> bad_answer', () => {
  const answers = {
    action: { type: 'choice', choice: 'bogus', confidence: 0.9, probabilities: { bogus: 0.9 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 0 });
  assert.equal(d.kind, 'vision'); assert.equal(d.reason, 'bad_answer');
});
check('interpretJevAnswers rule 2: goal reached -> done', () => {
  const answers = {
    action: { type: 'choice', choice: 'e1', confidence: 0.95, probabilities: { e1: 0.95, need_vision: 0.05 } },
    goal: { type: 'noul', noul: 0.95 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 1 });
  assert.equal(d.kind, 'done'); assertAlwaysFilled(d);
});
check('interpretJevAnswers rule 2: goal reached but executedCount 0 -> not done', () => {
  const answers = {
    action: { type: 'choice', choice: 'e1', confidence: 0.95, probabilities: { e1: 0.95, need_vision: 0.05 } },
    goal: { type: 'noul', noul: 0.95 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 0 });
  assert.notEqual(d.kind, 'done');
});
check('interpretJevAnswers rule 3: stuck -> vision/stuck', () => {
  const answers = {
    action: { type: 'choice', choice: 'e1', confidence: 0.95, probabilities: { e1: 0.95, need_vision: 0.05 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.9 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 1 });
  assert.equal(d.kind, 'vision'); assert.equal(d.reason, 'stuck');
});
check('interpretJevAnswers rule 4: need_vision choice', () => {
  const answers = {
    action: { type: 'choice', choice: 'need_vision', confidence: 0.5, probabilities: { need_vision: 0.5 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 0 });
  assert.equal(d.kind, 'vision'); assert.equal(d.reason, 'need_vision');
});
check('interpretJevAnswers rule 5: done choice but goal disagrees', () => {
  const answers = {
    action: { type: 'choice', choice: 'done', confidence: 0.9, probabilities: { done: 0.9 } },
    goal: { type: 'noul', noul: 0.5 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 1 });
  assert.equal(d.kind, 'vision'); assert.equal(d.reason, 'done_disagree');
});
check('interpretJevAnswers rule 7: low confidence click -> vision/low_conf', () => {
  const answers = {
    action: { type: 'choice', choice: 'e1', confidence: 0.5, probabilities: { e1: 0.5, need_vision: 0.5 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 0 });
  assert.equal(d.kind, 'vision'); assert.equal(d.reason, 'low_conf');
});
check('interpretJevAnswers rule 8: click', () => {
  const answers = {
    action: { type: 'choice', choice: 'e1', confidence: 0.9, probabilities: { e1: 0.9, need_vision: 0.1 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 0 });
  assert.equal(d.kind, 'act'); assert.equal(d.op, 'click'); assert.equal(d.elementId, 'e1');
});
check('interpretJevAnswers rule 8: key', () => {
  const answers = {
    action: { type: 'choice', choice: 'key_enter', confidence: 0.9, probabilities: { key_enter: 0.9, need_vision: 0.1 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 0 });
  assert.equal(d.kind, 'act'); assert.equal(d.op, 'key'); assert.equal(d.key, 'enter');
});
check('interpretJevAnswers rule 8: scroll', () => {
  const answers = {
    action: { type: 'choice', choice: 'scroll_down', confidence: 0.9, probabilities: { scroll_down: 0.9, need_vision: 0.1 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, fakeBuilt, { executedCount: 0 });
  assert.equal(d.kind, 'act'); assert.equal(d.op, 'scroll'); assert.equal(d.direction, 'down');
});

// rule 6: typing, using a real built object with literals from buildJevRequest
check('interpretJevAnswers rule 6: 1 literal, low type-confidence -> vision/low_conf', () => {
  const built = buildJevRequest(makeSmallSnapshot(), { goal: 'Type "hello world" in Notepad', history: [], excludeKeys: [], executedCount: 0 });
  const answers = {
    action: { type: 'choice', choice: 't_e1', confidence: 0.5, probabilities: { t_e1: 0.5, need_vision: 0.5 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, built, { executedCount: 0 });
  assert.equal(d.kind, 'vision'); assert.equal(d.reason, 'low_conf');
});
check('interpretJevAnswers rule 6: 1 literal, high confidence -> act/type verbatim literal', () => {
  const built = buildJevRequest(makeSmallSnapshot(), { goal: 'Type "hello world" in Notepad', history: [], excludeKeys: [], executedCount: 0 });
  const answers = {
    action: { type: 'choice', choice: 't_e1', confidence: 0.95, probabilities: { t_e1: 0.95, need_vision: 0.05 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
  };
  const d = interpretJevAnswers(answers, built, { executedCount: 0 });
  assert.equal(d.kind, 'act'); assert.equal(d.op, 'type'); assert.equal(d.text, 'hello world');
});
check('interpretJevAnswers rule 6: 2 literals, text x0 -> vision/text_none', () => {
  const built = buildJevRequest(makeSmallSnapshot(), { goal: 'Type "hello" then type "world"', history: [], excludeKeys: [], executedCount: 0 });
  const answers = {
    action: { type: 'choice', choice: 't_e1', confidence: 0.95, probabilities: { t_e1: 0.95, need_vision: 0.05 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
    text: { type: 'choice', choice: 'x0', confidence: 0.9, probabilities: { x0: 0.9 } },
  };
  const d = interpretJevAnswers(answers, built, { executedCount: 0 });
  assert.equal(d.kind, 'vision'); assert.equal(d.reason, 'text_none');
});
check('interpretJevAnswers rule 6: 2 literals, low text confidence -> vision/text_low_conf', () => {
  const built = buildJevRequest(makeSmallSnapshot(), { goal: 'Type "hello" then type "world"', history: [], excludeKeys: [], executedCount: 0 });
  const answers = {
    action: { type: 'choice', choice: 't_e1', confidence: 0.95, probabilities: { t_e1: 0.95, need_vision: 0.05 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
    text: { type: 'choice', choice: 'x2', confidence: 0.5, probabilities: { x2: 0.5 } },
  };
  const d = interpretJevAnswers(answers, built, { executedCount: 0 });
  assert.equal(d.kind, 'vision'); assert.equal(d.reason, 'text_low_conf');
});
check('interpretJevAnswers rule 6: 2 literals, x2 chosen confidently -> act/type "world"', () => {
  const built = buildJevRequest(makeSmallSnapshot(), { goal: 'Type "hello" then type "world"', history: [], excludeKeys: [], executedCount: 0 });
  const answers = {
    action: { type: 'choice', choice: 't_e1', confidence: 0.95, probabilities: { t_e1: 0.95, need_vision: 0.05 } },
    goal: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.1 },
    text: { type: 'choice', choice: 'x2', confidence: 0.9, probabilities: { x2: 0.9 } },
  };
  const d = interpretJevAnswers(answers, built, { executedCount: 0 });
  assert.equal(d.kind, 'act'); assert.equal(d.op, 'type'); assert.equal(d.text, 'world'); assert.equal(d.textConf, 0.9);
});

// ── snapshotSignature ────────────────────────────────────────────────────
check('snapshotSignature: equal for identical snapshots, differs on toggle flip', () => {
  const snapA = makeSmallSnapshot();
  const snapB = makeSmallSnapshot();
  assert.equal(snapshotSignature(snapA), snapshotSignature(snapB));

  const snapC = makeSmallSnapshot();
  snapC.elements[2].toggle = 'on'; // flip the CheckBox
  assert.notEqual(snapshotSignature(snapA), snapshotSignature(snapC));
});

// ── parseDotEnv ───────────────────────────────────────────────────────────
check('parseDotEnv: single line, no trailing newline', () => {
  assert.deepEqual(envKeys.parseDotEnv('jev=abc'), { jev: 'abc' });
});
check('parseDotEnv: BOM', () => {
  assert.deepEqual(envKeys.parseDotEnv('﻿jev=abc'), { jev: 'abc' });
});
check('parseDotEnv: quotes stripped', () => {
  assert.deepEqual(envKeys.parseDotEnv('KEY="value with spaces"\nOTHER=\'single quoted\''),
    { KEY: 'value with spaces', OTHER: 'single quoted' });
});
check('parseDotEnv: CRLF', () => {
  assert.deepEqual(envKeys.parseDotEnv('KEY=val\r\nAFTER=ok\r\n'), { KEY: 'val', AFTER: 'ok' });
});
check('parseDotEnv: comments/blanks ignored, later duplicate wins', () => {
  assert.deepEqual(envKeys.parseDotEnv('# comment\n\njev=first\njev=second\n'), { jev: 'second' });
});

console.log(`\n${passCount} checks passed.`);
console.log('ALL PASS');
