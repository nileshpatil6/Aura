// Pure functions: UIA snapshot + run context -> Jev request, Jev answers -> step decision.
// No I/O, no electron, no fetch. Unit-testable under plain node (scripts/jev-step-selftest.js).
// Contract: docs/jev-uia/CONTRACT.md section "jev-step.js".

const THRESHOLDS = Object.freeze({
  action: 0.85,     // min choice confidence to execute a Jev action
  typeAction: 0.90, // min choice confidence when the option is a t_eK typing option
  text: 0.85,       // min confidence on the `text` literal-selection question
  goal: 0.90,       // min goal noul to finish the run as done
  stuck: 0.85,      // stuck noul at/above which we hand the step to vision
});

// Jev-only mode has no vision fallback, so a hesitant-but-correct pick beats giving up.
// Typed text is still verbatim from the task (I9), which keeps the lower bar safe.
const JEV_ONLY_THRESHOLDS = Object.freeze({ ...THRESHOLDS, action: 0.6, typeAction: 0.55, text: 0.6 });

const LIMITS = Object.freeze({
  maxOptions: 255,      // Jev hard cap on choice options
  maxElements: 200,     // element options (e1..eN) per request
  maxTypeOptions: 20,   // t_eK options per request
  maxLiterals: 5,       // x1..xM
  maxHistory: 8,        // history lines in state
  maxStateTokens: 24000,// approx (chars / 3.5) for state + largest question
  nameChars: 80,
  valueChars: 60,
});

const OUTCOME_TEXT = { ok: 'ok', failed: 'failed', no_effect: 'no visible change', unknown: 'result unknown' };
const FILLER_CAPTURES = new Set(['it', 'this', 'that', 'the text', 'something']);

// Quote-pair extraction, order of appearance. Straight/curly double quotes and
// backticks are unconditional; straight/curly single quotes only count when
// they look like real quoting (not an apostrophe) — see contract rule 2.
const DOUBLE_QUOTE_RES = [/"([^"]*)"/g, /“([^”]*)”/g, /`([^`]*)`/g];
const SINGLE_QUOTE_RES = [
  /(?<=^|[\s(])'([^']+)'(?=$|[\s.,;!?)])/g,
  /(?<=^|[\s(])‘([^’]+)’(?=$|[\s.,;!?)])/g,
];
const VERB_RE = /\b(?:type|write|enter|input|search(?: for)?|find)\s+(.+?)(?=\s+(?:in|into|on|at|inside|and|then|&)\b|[.,;!?]|$)/gi;

function dedupTrimCap(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = String(raw == null ? '' : raw).trim();
    if (v.length < 1 || v.length > 200) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= LIMITS.maxLiterals) break;
  }
  return out;
}

/** @returns {string[]} unique literal strings to type, in order of appearance, max LIMITS.maxLiterals */
function extractLiteralTexts(goal) {
  const text = String(goal == null ? '' : goal);
  const candidates = [];

  for (const re of DOUBLE_QUOTE_RES) {
    for (const m of text.matchAll(re)) candidates.push({ index: m.index, value: m[1] });
  }
  for (const re of SINGLE_QUOTE_RES) {
    for (const m of text.matchAll(re)) candidates.push({ index: m.index, value: m[1] });
  }
  candidates.sort((a, b) => a.index - b.index);

  let results = dedupTrimCap(candidates.map(c => c.value));
  if (results.length > 0) return results;

  const verbCandidates = [];
  for (const m of text.matchAll(VERB_RE)) {
    const cap = (m[1] || '').trim();
    if (!cap) continue;
    if (FILLER_CAPTURES.has(cap.toLowerCase())) continue;
    verbCandidates.push(cap);
  }
  return dedupTrimCap(verbCandidates);
}

/** Stable across snapshots: `${type}|${name}|${aid}` (NOT the eN id). */
function elementKey(el) {
  return `${el.type}|${el.name}|${el.aid}`;
}

function cleanText(s) {
  return String(s == null ? '' : s).replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

/** Signature used for no-effect detection; see contract "No-effect detection". */
function snapshotSignature(snap) {
  const focused = snap.focused || null;
  const header = [
    snap.hwnd || '',
    snap.title || '',
    focused ? focused.type : '',
    focused ? focused.name : '',
  ].join('|') + '|';

  const elemStrs = (snap.elements || []).map((el) => {
    const rect = el.rect || [0, 0, 0, 0];
    const r = rect.map(v => Math.round(v / 8)).join(',');
    return [
      el.type || '',
      el.name || '',
      el.value !== undefined ? el.value : '',
      el.toggle !== undefined ? el.toggle : '',
      el.selected !== undefined ? el.selected : '',
      el.expand !== undefined ? el.expand : '',
      r,
    ].join('|');
  });

  return header + elemStrs.join(';');
}

/** One-line human/Jev description, e.g. `Button "Save"` / `Edit "Search" value="cats"` / `CheckBox "Wrap" [on]`. */
function describeElement(el) {
  let desc = `${el.type} "${cleanText(el.name || '')}"`;
  if (el.value !== undefined) desc += ` value="${cleanText(el.value)}"`;
  if (el.toggle !== undefined) desc += ` [${el.toggle}]`;
  if (el.selected === true) desc += ' [selected]';
  if (el.expand !== undefined) desc += ` [${el.expand}]`;
  if (el.readOnly === true) desc += ' [readonly]';
  return desc;
}

/** `3. [jev] clicked Button "Save" -> no visible change` */
function formatHistoryEntry(entry, index) {
  const outcomeText = OUTCOME_TEXT[entry.outcome] || 'result unknown';
  return `${index + 1}. [${entry.source}] ${entry.desc} -> ${outcomeText}`;
}

// Builds the state text + questions + optionMap for a given (already trimmed)
// element list. Called repeatedly by buildJevRequest while trimming to budget.
function assembleState(snap, kept, goal, literals, excludeKeys, history) {
  const focusedId = snap.focused && snap.focused.id;

  let focusedLine = '(none)';
  if (snap.focused) {
    if (focusedId) {
      const fullEl = kept.find(e => e.id === focusedId) || (snap.elements || []).find(e => e.id === focusedId);
      focusedLine = fullEl ? `${focusedId} ${describeElement(fullEl)}` : '(none)';
    } else {
      focusedLine = `${describeElement({ type: snap.focused.type, name: snap.focused.name })} (not in list)`;
    }
  }

  const lines = [];
  lines.push(`TASK: ${goal}`);
  lines.push(`WINDOW: "${snap.title || ''}" (process: ${snap.process || ''}, framework: ${snap.fw || ''})`);
  lines.push(`FOCUSED: ${focusedLine}`);
  lines.push(`ELEMENTS (${kept.length} shown of ${snap.total}):`);
  for (const el of kept) lines.push(`${el.id} ${describeElement(el)}`);

  if (literals.length > 0) {
    lines.push(`TEXT CANDIDATES: ${literals.map((l, i) => `x${i + 1} "${cleanText(l)}"`).join(' | ')}`);
  }

  lines.push('RECENT ACTIONS (oldest first):');
  const historySlice = (history || []).slice(-LIMITS.maxHistory);
  if (historySlice.length) {
    historySlice.forEach((entry, i) => lines.push(formatHistoryEntry(entry, i)));
  } else {
    lines.push('(none)');
  }

  const state = lines.join('\n');

  // ── options / criteria ────────────────────────────────────────────────
  const optionMap = {};
  const criteria = {};

  for (const el of kept) {
    if (excludeKeys.has(elementKey(el))) continue;
    optionMap[el.id] = { kind: 'click', elementId: el.id, el };
    criteria[el.id] = `click ${describeElement(el)}`;
  }

  if (literals.length > 0) {
    const eligible = kept.filter((el) => {
      if (excludeKeys.has(elementKey(el))) return false;
      if (el.readOnly) return false;
      if (el.type === 'Edit' || el.type === 'Document') return true;
      if (el.type === 'ComboBox' && Array.isArray(el.pats) && el.pats.includes('value')) return true;
      return false;
    });
    eligible.sort((a, b) => (a.focused ? 0 : 1) - (b.focused ? 0 : 1)); // focused first, stable otherwise
    for (const el of eligible.slice(0, LIMITS.maxTypeOptions)) {
      const key = `t_${el.id}`;
      optionMap[key] = { kind: 'type', elementId: el.id, el };
      criteria[key] = `type the text from TEXT CANDIDATES into ${describeElement(el)}`;
    }
  }

  optionMap.key_enter = { kind: 'key', key: 'enter' };
  criteria.key_enter = 'press Enter to submit or confirm';
  optionMap.key_escape = { kind: 'key', key: 'escape' };
  criteria.key_escape = 'press Escape to close or cancel';
  optionMap.scroll_down = { kind: 'scroll', direction: 'down' };
  criteria.scroll_down = 'scroll the window to reveal more content';
  optionMap.scroll_up = { kind: 'scroll', direction: 'up' };
  criteria.scroll_up = 'scroll the window to reveal more content';
  optionMap.done = { kind: 'done' };
  criteria.done = 'the task is already complete';
  optionMap.need_vision = { kind: 'need_vision' };
  criteria.need_vision = 'none of these options fits, or unsure';

  const questions = {
    action: {
      type: 'choice',
      instructions: 'Choose the single next UI action that best advances TASK. Choosing an element id ' +
        'clicks/activates that element. Choose need_vision if the needed control is not listed, the task ' +
        'needs anything these options cannot do (launching an app, a hotkey, drawing, reading images), or ' +
        'you are unsure.',
      criteria,
    },
    goal: {
      type: 'noul',
      instructions: 'Is TASK already fully completed, judging only by WINDOW, ELEMENTS and RECENT ACTIONS?',
    },
    stuck: {
      type: 'noul',
      instructions: 'Are the RECENT ACTIONS repeating the same thing without making progress?',
    },
  };

  if (literals.length >= 2) {
    const textCriteria = {};
    literals.forEach((lit, i) => { textCriteria[`x${i + 1}`] = lit; });
    textCriteria.x0 = 'none of these is the text that should be typed now';
    questions.text = {
      type: 'choice',
      instructions: 'Which text should be typed next for TASK?',
      criteria: textCriteria,
    };
  }

  const questionJsonLens = Object.values(questions).map(q => JSON.stringify(q).length);
  const largestQuestionJson = questionJsonLens.length ? Math.max(...questionJsonLens) : 0;
  const approxTokens = Math.ceil((state.length + largestQuestionJson) / 3.5);

  return { state, questions, optionMap, approxTokens, optionCount: Object.keys(optionMap).length };
}

/**
 * @param {object} snap  UiaSnapshot with ok:true
 * @param {{ goal:string, history:object[], excludeKeys:string[], executedCount:number }} ctx
 * @returns {{ state:string, questions:object, optionMap:Record<string,object>, literals:string[], approxTokens:number }}
 */
function buildJevRequest(snap, ctx) {
  const goal = ctx.goal || '';
  const excludeKeys = new Set(ctx.excludeKeys || []);
  const history = ctx.history || [];
  const literals = extractLiteralTexts(goal);
  const focusedId = snap.focused && snap.focused.id;

  let kept = (snap.elements || []).slice(); // host already caps at maxElements

  let result;
  // Trim from the end (protecting the focused element) until within budget.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    result = assembleState(snap, kept, goal, literals, excludeKeys, history);
    if (result.approxTokens <= LIMITS.maxStateTokens && result.optionCount <= LIMITS.maxOptions) break;

    let dropIdx = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (!focusedId || kept[i].id !== focusedId) { dropIdx = i; break; }
    }
    if (dropIdx === -1) break; // nothing left we're allowed to drop
    kept.splice(dropIdx, 1);
  }

  return {
    state: result.state,
    questions: result.questions,
    optionMap: result.optionMap,
    literals,
    approxTokens: result.approxTokens,
  };
}

function top2Of(probabilities) {
  return Object.entries(probabilities || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
}

/**
 * @param {Record<string,object>} answers  JevResult.answers
 * @param {ReturnType<typeof buildJevRequest>} built
 * @param {{ executedCount:number }} ctx
 * @returns {object} JevDecision (see contract)
 */
function interpretJevAnswers(answers, built, ctx) {
  const action = answers && answers.action;
  const goalAns = answers && answers.goal;
  const stuckAns = answers && answers.stuck;

  const actionValid = !!action && action.type === 'choice' &&
    typeof action.choice === 'string' && typeof action.confidence === 'number' &&
    action.probabilities && typeof action.probabilities === 'object';
  const goalValid = !!goalAns && goalAns.type === 'noul' && typeof goalAns.noul === 'number';
  const stuckValid = !!stuckAns && stuckAns.type === 'noul' && typeof stuckAns.noul === 'number';

  const choice = actionValid ? action.choice : '';
  const conf = actionValid ? action.confidence : 0;
  const goalVal = goalValid ? goalAns.noul : 0;
  const stuckVal = stuckValid ? stuckAns.noul : 0;
  const top2 = actionValid ? top2Of(action.probabilities) : [];
  const base = { choice, conf, goal: goalVal, stuck: stuckVal, top2 };
  const T = ctx && ctx.jevOnly ? JEV_ONLY_THRESHOLDS : THRESHOLDS;
  // Jev-only: a clear winner counts even under the bar (top pick >= 0.45 and at least 2x the runner-up).
  const clearWinner = !!(ctx && ctx.jevOnly) && conf >= 0.45 && top2.length === 2 && conf >= 2 * top2[1][1];
  const below = (bar) => conf < bar && !clearWinner;

  // 1. bad answer shape / unknown choice
  if (!actionValid || !goalValid || !stuckValid || !(choice in built.optionMap)) {
    return { ok: true, kind: 'vision', reason: 'bad_answer', ...base };
  }

  // 2. goal reached
  if (goalVal >= T.goal && ctx.executedCount >= 1) {
    return { ok: true, kind: 'done', ...base };
  }

  // 3. stuck
  if (stuckVal >= T.stuck) {
    return { ok: true, kind: 'vision', reason: 'stuck', ...base };
  }

  // 4. explicit need_vision
  if (choice === 'need_vision') {
    return { ok: true, kind: 'vision', reason: 'need_vision', ...base };
  }

  // 5. Jev thinks done but goal noul disagrees
  if (choice === 'done') {
    return { ok: true, kind: 'vision', reason: 'done_disagree', ...base };
  }

  const opt = built.optionMap[choice];

  // 6. typing option
  if (opt.kind === 'type') {
    if (below(T.typeAction)) {
      return { ok: true, kind: 'vision', reason: 'low_conf', ...base };
    }

    let text;
    let textConf;
    if (built.literals.length === 1) {
      text = built.literals[0];
    } else {
      const textAns = answers.text;
      const textValid = !!textAns && textAns.type === 'choice' &&
        typeof textAns.choice === 'string' && typeof textAns.confidence === 'number';
      if (!textValid) {
        return { ok: true, kind: 'vision', reason: 'bad_answer', ...base };
      }
      textConf = textAns.confidence;
      if (textAns.choice === 'x0') {
        return { ok: true, kind: 'vision', reason: 'text_none', ...base, textConf };
      }
      if (textConf < T.text) {
        return { ok: true, kind: 'vision', reason: 'text_low_conf', ...base, textConf };
      }
      const m = /^x(\d+)$/.exec(textAns.choice);
      const idx = m ? Number(m[1]) - 1 : -1;
      if (idx < 0 || idx >= built.literals.length) {
        return { ok: true, kind: 'vision', reason: 'bad_answer', ...base, textConf };
      }
      text = built.literals[idx];
    }

    return {
      ok: true, kind: 'act', op: 'type',
      elementId: opt.elementId, target: describeElement(opt.el), text,
      ...base, ...(textConf !== undefined ? { textConf } : {}),
    };
  }

  // 7. any other choice below the action-confidence bar
  if (below(T.action)) {
    return { ok: true, kind: 'vision', reason: 'low_conf', ...base };
  }

  // 8. click / key / scroll
  if (opt.kind === 'click') {
    return { ok: true, kind: 'act', op: 'click', elementId: opt.elementId, target: describeElement(opt.el), ...base };
  }
  if (opt.kind === 'key') {
    return { ok: true, kind: 'act', op: 'key', key: opt.key, ...base };
  }
  if (opt.kind === 'scroll') {
    return { ok: true, kind: 'act', op: 'scroll', direction: opt.direction, ...base };
  }

  // optionMap only ever produces the kinds handled above; unreachable in practice.
  return { ok: true, kind: 'vision', reason: 'bad_answer', ...base };
}

module.exports = {
  THRESHOLDS, LIMITS,
  extractLiteralTexts, elementKey, snapshotSignature, describeElement,
  formatHistoryEntry, buildJevRequest, interpretJevAnswers,
};
