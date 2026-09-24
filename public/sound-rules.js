export const SOUND_PRESETS = [
  { id: 'wood', label: '木音', description: '轻短、温暖的敲击' },
  { id: 'glass', label: '玻璃', description: '清亮、有少许余韵' },
  { id: 'bell', label: '铃音', description: '柔和的双音泛音' },
  { id: 'low', label: '低音', description: '低沉、克制的回声' },
  { id: 'brush', label: '沙刷', description: '细密而短的颗粒' },
  { id: 'click', label: '微响', description: '干净的短促点击' },
  { id: 'dissonance', label: '不和谐音', description: '相邻半音的短促碰撞，用于关注的调用' },
  { id: 'mute', label: '静音', description: '保留记录，不播放' },
];

export const MATCH_LABELS = { type:'事件', category:'类别', hookPoint:'Hook', handlerId:'Handler', toolName:'工具', skillName:'Skill', outcome:'结果', callContains:'调用关键词' };
export const NAME_FIELDS = ['toolName', 'skillName'];
const textCondition = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;

export function validMatchCondition(key, value) {
  if (!Object.hasOwn(MATCH_LABELS, key)) return false;
  if (typeof value === 'string') return textCondition(value);
  return NAME_FIELDS.includes(key) && value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.hasOwn(value, 'contains') && textCondition(value.contains);
}

// Inspect only invocation evidence. Returned content, conversation text and the
// truncated display summary must not turn a mere mention into a watched call.
function invocationFields(event) {
  if (event.type === 'user/message' && event.skillEvidence === 'explicit-invocation') {
    return [['skillName', event.skillName]];
  }
  if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch-start') return [];
  let args = event.raw?.data?.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* Incomplete arguments remain searchable as recorded. */ }
  }
  return [['toolName', event.toolName], ['skillName', event.skillName],
    ['arguments', typeof args === 'string' ? args : JSON.stringify(args)]];
}

function containsEvidence(field, actual, expected) {
  if (typeof actual !== 'string') return null;
  const index = actual.toLowerCase().indexOf(expected.toLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 80);
  const end = Math.min(actual.length, index + expected.length + 80);
  return { field, operator: 'contains', expected, value: `${start ? '…' : ''}${actual.slice(start, end)}${end < actual.length ? '…' : ''}` };
}

function conditionEvidence(event, key, expected) {
  if (!validMatchCondition(key, expected)) return null;
  if (key === 'callContains') {
    return invocationFields(event).map(([field, actual]) => containsEvidence(field, actual, expected)).find(Boolean) ?? null;
  }
  if (typeof expected === 'object') return containsEvidence(key, event[key], expected.contains);
  if (event[key] == null || String(event[key]) !== expected) return null;
  return { field: key, operator: 'equals', expected, value: String(event[key]) };
}

export function matchSound(event, settings) {
  for (const rule of settings.rules || []) {
    if (!rule.enabled) continue;
    const evidence = Object.entries(rule.match || {}).map(([key, value]) => conditionEvidence(event, key, value));
    if (evidence.some(item => item === null)) continue;
    const volume = Number.isFinite(Number(rule.volume)) ? Math.max(0, Math.min(1, Number(rule.volume))) : 0.5;
    return { sound: rule.sound || 'mute', volume, ruleId: rule.id, reason: '声音规则', evidence };
  }
  return { sound: settings.categorySounds?.[event.category] || 'mute', volume: 0.5, ruleId: null, reason: '类别默认', evidence: [] };
}
