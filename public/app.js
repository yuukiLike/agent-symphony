import { AudioEngine, SOUND_PRESETS, matchSound } from './audio.js';
import { MATCH_LABELS, NAME_FIELDS } from './sound-rules.js';

const $ = selector => document.querySelector(selector);
const audio = new AudioEngine();
const CATEGORY_LABELS = { session:'会话', model:'模型', tool:'工具', hook:'Hook', context:'上下文', interaction:'交互', collaboration:'协作', artifact:'产物', other:'其他' };
const GLYPHS = { session:'◉', model:'◇', tool:'↗', hook:'⌁', context:'≡', interaction:'↳', collaboration:'⋈', artifact:'▤', other:'·' };
const OUTCOME_LABELS = { success:'成功', failure:'失败', blocked:'被阻止', cancelled:'已取消', unknown:'未知' };
const state = {
  sessions:[], selectedKey:null, events:[], catalog:{ events:[], hooks:[], categories:[] }, sounds:[], status:null,
  settings:{ audio:{enabled:false,volume:0.35},rules:[],categorySounds:{} },
  query:'', category:'', skill:'', skillEvidence:'', failures:false, selectedEvent:null, follow:true, visibleLimit:500,
  tab:'events', loadGeneration:0, loading:false, streamConnected:false, audioReady:false,
  replay:{ mode:false, playing:false, finished:false, cursor:0, timer:null, generation:0, currentId:null, events:[] },
  playback:[], editingRuleId:null, saving:false, pendingLiveDemo:false, sessionViews:new Map(), pendingViewRestore:null,
};
let toastTimer;
let refreshTimer;
let saveTimer;
let saveChain = Promise.resolve();
let savedRevision = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, error ? 6500 : 3500);
}

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== 'GET') headers['X-Symphony-Local'] = '1';
  if (options.json !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.json); }
  const response = await fetch(path, { ...options, headers });
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务返回了无法读取的响应（${response.status}）。`); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.message || `请求失败（${response.status}）`);
  return data;
}

function run(task) { Promise.resolve().then(task).catch(error => toast(error.message || '操作未完成，请重试。', true)); }
function currentSession() { return state.sessions.find(session => session.key === state.selectedKey); }
function categoryLabel(category) { return state.catalog.categories.find(item => item.id === category)?.label || CATEGORY_LABELS[category] || category; }
function soundLabel(sound) { return SOUND_PRESETS.find(item => item.id === sound)?.label || state.sounds.find(item => item.sound === sound)?.name || sound; }
function sourceLabel(session) { return session.sourceKind === 'demo' ? '演示' : session.sourceKind === 'import' ? '导入' : '现场'; }
function shortIdentity(value,limit=19) {const text=String(value || '来源未知');return text.length>limit?`${text.slice(0,limit-7)}…${text.slice(-6)}`:text;}
function timestamp(event) { return typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0 ? event.time : null; }
function eventId(event) { return event.id || `${event.sessionKey}:${event.seq}`; }
function timeText(value, includeDate = false) {
  if (!value || !Number.isFinite(Number(value))) return '时间未知';
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { ...(includeDate ? {month:'2-digit',day:'2-digit'} : {}),hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false });
}
function durationText(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60000)}m ${Math.floor(value % 60000 / 1000)}s`;
}
function addOption(select, value, label) { const option = el('option', '', label); option.value = value; select.append(option); }
function makeButton(label, className, handler, title) { const button = el('button', className, label); button.type = 'button'; if (title) { button.title = title; button.setAttribute('aria-label', title); } button.addEventListener('click', handler); return button; }

function showTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const name of ['events','sounds','connection']) $(`#view-${name}`).hidden = tab !== name;
  $('#event-detail').hidden=true;
  if(tab==='events' && state.selectedEvent){const event=state.events.find(item=>eventId(item)===state.selectedEvent);if(event)showDetail(event);}
}

function renderSessions() {
  $('#session-count').textContent = state.sessions.length;
  const query = $('#session-search').value.trim().toLowerCase();
  const list = $('#session-list');
  list.replaceChildren();
  const sessions = state.sessions.filter(session => [session.title,session.cwd,session.id,session.sourceId,session.sourceLabel,session.key].some(value => String(value || '').toLowerCase().includes(query)));
  for (const session of sessions) {
    const button = el('button', `session-item${session.key === state.selectedKey ? ' selected' : ''}`);
    button.type = 'button';button.dataset.sessionKey=session.key; button.setAttribute('aria-pressed', String(session.key === state.selectedKey));
    const top = el('span','session-item-top');
    top.append(el('span','source-label','DSH'), el('span',`mode-pill${session.sourceKind === 'demo' ? ' demo' : ''}`,sourceLabel(session)));
    const name = el('span','session-item-name', session.title || '未命名会话'); name.title = session.title || session.id;
    const meta = el('span','session-item-meta'); meta.append(el('span','',String(session.id).slice(0,8)),el('span','',`${session.eventCount || 0} events`));
    const identity=el('span','session-item-identity');
    const source=el('span','',shortIdentity(session.sourceLabel || session.sourceId));source.title=`${session.sourceLabel || '来源'} · ${session.sourceId || '来源 ID 未提供'}`;
    const key=el('code','',`#${String(session.key).slice(0,8)}`);key.title=session.key;identity.append(source,key);
    button.append(top,name,meta,identity); button.addEventListener('click',()=>run(()=>selectSession(session.key)));
    list.append(button);
  }
  if (!sessions.length) list.append(el('div','sidebar-empty', query ? '没有匹配的会话。' : '还没有记录。\n接入 dsh 或打开演示开始。'));
}

async function refreshSessions({ chooseFirst = false } = {}) {
  const data = await api('/api/sessions');
  state.sessions = data.sessions || [];
  renderSessions();
  if (!state.selectedKey && chooseFirst && state.sessions.length) await selectSession(state.sessions[0].key);
  else renderSessionHeading();
}

async function selectSession(key) {
  if (key === state.selectedKey) return state.loading ? undefined : loadEvents(key);
  if(state.selectedKey)state.sessionViews.set(state.selectedKey,{
    query:state.query,category:state.category,skill:state.skill,skillEvidence:state.skillEvidence,failures:state.failures,
    selectedEvent:state.selectedEvent,scrollTop:$('#timeline').scrollTop,follow:state.follow,visibleLimit:state.visibleLimit,
  });
  const view=state.sessionViews.get(key) || {query:'',category:'',skill:'',skillEvidence:'',failures:false,selectedEvent:null,scrollTop:null,follow:true,visibleLimit:500};
  stopReplay(true);
  audio.cancel();
  state.selectedKey = key;
  state.events = [];
  state.selectedEvent = null;
  for(const field of ['query','category','skill','skillEvidence','failures','follow','visibleLimit'])state[field]=view[field];
  state.pendingViewRestore={key,selectedEvent:view.selectedEvent,scrollTop:view.scrollTop};
  $('#event-search').value=state.query;
  $('#category-filter').value=state.category;
  $('#failure-filter').checked=state.failures;
  const skill=$('#skill-filter');skill.replaceChildren();addOption(skill,'','所有 skill');if(state.skill)addOption(skill,state.skill,state.skill);skill.value=state.skill;
  const evidence=$('#skill-evidence-filter');evidence.replaceChildren();addOption(evidence,'','全部证据类型');if(state.skillEvidence)addOption(evidence,state.skillEvidence,state.skillEvidence);evidence.value=state.skillEvidence;evidence.hidden=!state.skill;
  $('#follow-button').classList.toggle('active',state.follow);
  $('#follow-button').textContent=state.follow?'跟随最新 ↓':'已停止跟随';
  closeDetail();
  showTab('events');
  renderSessions();
  renderSessionHeading();
  renderTimeline();
  await loadEvents(key);
}

function mergeEvents(existing, incoming) {
  const map = new Map(existing.map(event => [eventId(event), event]));
  for (const event of incoming) if (event.sessionKey === state.selectedKey) map.set(eventId(event),event);
  return [...map.values()].sort((a,b) => a.seq - b.seq);
}

async function loadEvents(key = state.selectedKey) {
  if (!key) return;
  const generation = ++state.loadGeneration;
  state.loading = true;
  $('#load-state').textContent = '正在读取完整记录…';
  let after = -1;
  const loaded = [];
  try {
    do {
      const data = await api(`/api/sessions/${encodeURIComponent(key)}/events?after=${after}&limit=1000`);
      if (generation !== state.loadGeneration || key !== state.selectedKey) return;
      loaded.push(...(data.events || []));
      $('#load-state').textContent = `正在读取记录 · ${loaded.length} 条`;
      if (!data.hasMore) break;
      const next = Number(data.nextAfter);
      if (!Number.isFinite(next) || next <= after) throw new Error('记录分页游标未前进，已停止加载。');
      after = next;
    } while (true);
    state.events = mergeEvents(loaded,state.events);
    updateSkillOptions();
    renderSessionHeading();
    renderTimeline();
    const view=state.pendingViewRestore;
    if(view?.key===key){
      state.pendingViewRestore=null;
      if(view.selectedEvent){const selected=state.events.find(event=>eventId(event)===view.selectedEvent);if(selected)showDetail(selected);}
      if(view.scrollTop!=null)$('#timeline').scrollTop=view.scrollTop;
    }
  } finally {
    if (generation === state.loadGeneration) { state.loading = false; $('#load-state').textContent = ''; }
  }
}

function renderSessionHeading() {
  const session = currentSession();
  $('#empty-workspace').hidden = Boolean(session);
  $('#session-workspace').hidden = !session;
  if (!session) return;
  $('#session-title').textContent = session.title || '未命名会话';
  $('#session-cwd').textContent = session.cwd || '工作目录未提供';
  $('#session-short-id').textContent = session.id;
  $('#session-source').textContent = 'DSH';
  $('#session-source-name').textContent=session.sourceLabel || '来源';
  $('#session-source-id').textContent=session.sourceId || '来源 ID 未提供';
  const lineage=$('#session-lineage');lineage.replaceChildren();
  if(session.parentSession){
    const parent=state.sessions.find(item=>item.sourceId===session.sourceId && item.id===session.parentSession);
    if(parent)lineage.append(makeButton(`↑ 父会话 · ${parent.title || parent.id}`,'text-button',()=>run(()=>selectSession(parent.key))));
    else lineage.append(el('span','fine-print',`父会话 ${session.parentSession} · 尚未记录`));
  }
  for(const child of state.sessions.filter(item=>item.sourceId===session.sourceId && item.parentSession===session.id))lineage.append(makeButton(`↳ 子会话 · ${child.title || child.id}`,'text-button',()=>run(()=>selectSession(child.key))));
  lineage.hidden=!lineage.childElementCount;
  $('#session-key').textContent=`#${String(session.key).slice(0,10)}`;
  $('#session-key').title=session.key;
  const mode = $('#session-mode');
  mode.textContent = state.replay.mode ? '回放' : sourceLabel(session);
  mode.className = `mode-pill${state.replay.mode ? ' replay' : session.sourceKind === 'demo' ? ' demo' : ''}`;
  const labels = {running:'来源报告运行中',active:'来源报告运行中','observed-active':'最后观察到执行中',completed:'上次回合已结束',idle:'来源报告已空闲',failed:'上次回合异常',unknown:'状态未知',ended:'已结束',blocked:'上次回合被阻止',cancelled:'上次回合取消',interrupted:'上次回合中断',limited:'上次回合达到限制'};
  $('#session-state').textContent = state.replay.mode ? '现场记录仍在继续' : labels[session.status] || session.status || '';
  $('#event-total').textContent = state.events.length || session.eventCount || 0;
  $('#event-errors').textContent = session.errorCount || 0;
  const times = state.events.map(timestamp).filter(value=>value!=null);
  const bounds=times.reduce((range,time)=>[Math.min(range[0],time),Math.max(range[1],time)],[Infinity,-Infinity]);
  $('#session-span').textContent = times.length > 1 ? durationText(bounds[1]-bounds[0]) : '—';
  $('#session-origin-note').textContent = session.sourceKind === 'demo' ? '模拟数据 · 不启动 agent' : session.sourceKind === 'import' ? '历史导入 · 不自动播放' : '仅监听当前会话';
  const gaps = session.gaps || [];
  $('#gap-banner').hidden = !gaps.length;
  $('#gap-banner').textContent = `这份记录包含 ${gaps.length} 处采集缺口：${gaps.map(gap=>`${gap.reason || '来源未说明'}${gap.count ? `（${gap.count} 条）` : ''}`).join('；')}。缺失区间不推断执行情况。`;
}

function updateSkillOptions() {
  const select = $('#skill-filter');
  const names = new Map();
  for (const skill of currentSession()?.skills || []) names.set(skill.name,skill.evidence);
  for (const event of state.events) if (event.skillName) names.set(event.skillName,event.skillEvidence);
  select.replaceChildren(); addOption(select,'','所有 skill');
  for (const [name] of names) addOption(select,name,name);
  if (names.has(state.skill)) select.value = state.skill;
  else { state.skill=''; select.value=''; }
  updateSkillEvidenceOptions();
}

function updateSkillEvidenceOptions() {
  const select=$('#skill-evidence-filter');
  select.hidden=!state.skill;
  const evidence=[...new Set(state.events.filter(event=>event.skillName===state.skill).map(event=>event.skillEvidence).filter(Boolean))];
  select.replaceChildren();addOption(select,'','全部证据类型');
  const labels={'explicit-invocation':'明确调用','tool-request':'工具调用请求','tool-result':'工具调用结果','tool-result-success':'工具调用成功','tool-result-failure':'工具调用失败','file-read':'读取文件','tool-execution':'工具执行'};
  for(const value of evidence)addOption(select,value,labels[value] || value);
  if(evidence.includes(state.skillEvidence))select.value=state.skillEvidence;
  else {state.skillEvidence='';select.value='';}
}

function filteredEvents() {
  const query = state.query.toLowerCase();
  return state.events.filter(event => {
    if (state.category && event.category !== state.category) return false;
    if (state.skill && event.skillName !== state.skill) return false;
    if (state.skillEvidence && event.skillEvidence !== state.skillEvidence) return false;
    if (state.failures && event.outcome !== 'failure' && event.outcome !== 'blocked') return false;
    if (!query) return true;
    return [event.type,event.label,event.summary,event.toolName,event.hookPoint,event.handlerId,event.callId,event.skillName,String(event.seq)].some(value=>String(value || '').toLowerCase().includes(query));
  });
}

function correlationDuration(event) {
  if(event.type==='hook/result' && typeof event.raw?.data?.durationMs==='number' && Number.isFinite(event.raw.data.durationMs) && event.raw.data.durationMs>=0)return event.raw.data.durationMs;
  if (!event.correlationKey || event.phase !== 'end' || timestamp(event) == null) return null;
  const starts = state.events.filter(candidate => candidate.correlationKey === event.correlationKey && candidate.phase === 'start' && candidate.seq < event.seq);
  if (starts.length !== 1 || timestamp(starts[0]) == null) return null;
  const duration = timestamp(event) - timestamp(starts[0]);
  return duration >= 0 ? duration : null;
}

function renderTimeline() {
  const events = filteredEvents();
  const timeline = $('#timeline');
  const scrollTop = timeline.scrollTop;
  timeline.replaceChildren();
  const shown = events.slice(-state.visibleLimit);
  $('#filtered-count').textContent = `${events.length} 条${state.query || state.category || state.skill || state.failures ? '筛选结果' : '执行记录'}`;
  $('#timeline-empty').hidden = events.length > 0 || state.loading;
  $('#clear-filters').hidden = !(state.query || state.category || state.skill || state.failures);
  $('#skill-context').hidden = !state.skill;
  const evidence = [...new Set(events.map(event=>event.skillEvidence).filter(Boolean))];
  $('#skill-context').textContent = `调查 ${state.skill} · ${events.length} 条具名证据${evidence.length ? ` · ${evidence.join(' / ')}` : ''}。仅筛选来源明确标记的事件，不把相邻动作自动归属给 skill。`;
  if (events.length > shown.length) timeline.append(makeButton(`显示更早记录（还有 ${events.length-shown.length} 条）`,'text-button',()=>{ state.visibleLimit+=500; renderTimeline(); }));
  for (const event of shown) {
    const row = el('button',`event-row${state.selectedEvent === eventId(event) ? ' selected' : ''}${state.replay.currentId === eventId(event) ? ' playing' : ''}`);
    row.type='button'; row.dataset.eventId=eventId(event);
    const time = el('span','event-time'); time.append(el('span','',timeText(timestamp(event))),el('small','',`#${event.seq}`));
    const glyph = el('span',`event-glyph ${event.category}`,GLYPHS[event.category] || '·'); glyph.setAttribute('aria-hidden','true');
    const main = el('span','event-main');
    const title = el('span','event-title'); title.append(el('span','event-label',event.label || event.type),el('span','event-type',event.type));
    main.append(title,el('span','event-summary',event.summary || event.toolName || event.hookPoint || '来源未提供摘要'));
    const tail = el('span','event-tail');
    if (event.outcome && event.outcome !== 'unknown') tail.append(el('span',`outcome ${event.outcome}`,OUTCOME_LABELS[event.outcome] || event.outcome));
    else if (event.phase === 'start') tail.append(el('span','outcome','开始'));
    const duration = correlationDuration(event);
    if (duration != null) tail.append(el('span','event-duration',durationText(duration)));
    const sound = matchSound(event,state.settings);
    tail.append(el('span','event-sound',sound.sound === 'mute' ? '静音' : `♪ ${soundLabel(sound.sound)}`));
    row.append(time,glyph,main,tail);
    row.addEventListener('click',()=>showDetail(event));
    timeline.append(row);
  }
  if (state.follow && !state.replay.mode) timeline.scrollTop=timeline.scrollHeight;
  else timeline.scrollTop=scrollTop;
  renderReplay();
}

function closeDetail() { $('#event-detail').hidden=true; state.selectedEvent=null; }

function showDetail(event) {
  state.selectedEvent=eventId(event);
  const content=$('#detail-content'); content.replaceChildren();
  content.append(el('h2','',event.label || event.type),el('div','detail-native',event.type),el('p','detail-summary',event.summary || '这条事件没有摘要。'));
  const values = [['来源',`${event.sourceKind || 'unknown'} / ${event.sourceId || '—'}`],['Session',event.sessionId],['顺序',event.seq],['源时间',timeText(timestamp(event),true)],['接收时间',timeText(event.receivedAt,true)],['类别',categoryLabel(event.category)],['阶段',event.phase],['结果',OUTCOME_LABELS[event.outcome] || event.outcome],['工具',event.toolName],['调用 ID',event.callId],['Hook',event.hookPoint],['Handler',event.handlerId],['Skill',event.skillName],['Skill 证据',event.skillEvidence],['关联键',event.correlationKey]];
  const duration=correlationDuration(event); if(duration!=null) values.push([event.type==='hook/result' && Number.isFinite(event.raw?.data?.durationMs)?'宿主报告耗时':'起止时间间隔',durationText(duration)]);
  const dl=el('dl','definition-list'); for(const [label,value] of values) if(value!=null && value!=='') dl.append(el('dt','',label),el('dd','',typeof value==='object'?JSON.stringify(value):value));
  content.append(dl,el('h3','','这次为什么是这个声音'));
  const match=matchSound(event,state.settings); const soundBox=el('div','sound-evidence');
  const index=state.settings.rules.findIndex(rule=>rule.id===match.ruleId);
  soundBox.append(el('div','',`${soundLabel(match.sound)} · ${match.ruleId ? `第 ${index+1} 条声音规则` : `${categoryLabel(event.category)}类别默认`} · 音量 ${Math.round(match.volume*100)}%`));
  for (const evidence of match.evidence) {
    const label = evidence.field === 'arguments' ? '调用参数' : MATCH_LABELS[evidence.field] || evidence.field;
    soundBox.append(el('p','match-evidence',`${label}${evidence.operator === 'contains' ? `包含「${evidence.expected}」` : `精确匹配「${evidence.expected}」`}：${evidence.value}`));
  }
  const actions=el('div','button-row'); actions.append(makeButton('▷ 回听这条','button small',()=>run(()=>previewSound(match.sound,match.volume))),makeButton('配置声音','button small',()=>openRule(null, { type:event.type, ...(event.hookPoint ? {hookPoint:event.hookPoint}:{}), ...(event.handlerId ? {handlerId:event.handlerId}:{}) })));
  soundBox.append(actions); content.append(soundBox);
  if(event.correlationKey) {
    const related=state.events.filter(item=>item.correlationKey===event.correlationKey && eventId(item)!==eventId(event));
    content.append(el('h3','',`同一原生关联（${related.length}）`));
    if(!related.length) content.append(el('p','fine-print','尚无其他配对记录；不推测开始、结束或耗时。'));
    for(const item of related) content.append(makeButton(`#${item.seq} · ${item.type} · ${timeText(timestamp(item))}`,'related-event',()=>showDetail(item)));
  } else content.append(el('p','fine-print','来源未提供关联键；此处不按时间相邻推断因果关系。'));
  const plays=state.playback.filter(item=>item.eventId===eventId(event));
  if(plays.length) { content.append(el('h3','','本次打开页面的播放记录')); for(const play of plays) content.append(el('div','playback-list',`${timeText(play.at)} · ${play.mode} · ${soundLabel(play.sound)} · ${play.ruleId || '类别默认'} · ${play.status}`)); }
  content.append(el('h3','','保留的原始证据'));
  const pre=el('pre','raw-json',JSON.stringify(event.raw || event,null,2)); content.append(pre);
  $('#event-detail').hidden=false;
  for(const row of $('#timeline').querySelectorAll('.event-row')) row.classList.toggle('selected',row.dataset.eventId===eventId(event));
}

function renderAudio() {
  const enabled=state.settings.audio.enabled && state.audioReady;
  $('#audio-toggle').classList.toggle('enabled',enabled);
  $('#audio-toggle').setAttribute('aria-pressed',String(enabled));
  $('#audio-toggle-label').textContent=enabled ? '声音已开启' : state.settings.audio.enabled ? '点击恢复声音' : '开启声音';
  $('#master-volume').value=state.settings.audio.volume;
  $('#master-volume-label').textContent=`${Math.round(state.settings.audio.volume*100)}%`;
  audio.setVolume(state.settings.audio.volume);
}

async function enableAudio() { await audio.unlock(); state.audioReady=true; state.settings.audio.enabled=true; renderAudio(); queueSettingsSave(); }
async function previewSound(sound, volume=0.5) { if(state.replay.playing)stopReplay();audio.cancel();await audio.unlock(); state.audioReady=true; renderAudio(); if(sound==='mute') { toast('这条规则设为静音。'); return; } await audio.play(sound,volume); }

async function soundEvent(event, mode) {
  const match=matchSound(event,state.settings);
  const item={eventId:eventId(event),at:Date.now(),mode,sound:match.sound,ruleId:match.ruleId,status:'已静音'};
  state.playback.push(item); if(state.playback.length>1500) state.playback.shift();
  if(!state.settings.audio.enabled || !state.audioReady) { item.status='全局声音关闭'; return; }
  if(match.sound==='mute') return;
  try { item.status=await audio.play(match.sound,match.volume)?'已播放':'未播放'; }
  catch(error) { item.status='音频不可用'; toast(error.message,true); }
}

function replayHasTimes(events) { return events.length>0 && events.every((event,index)=>timestamp(event)!=null && (!index || timestamp(event)>=timestamp(events[index-1]))); }
function replayItems() { return state.replay.mode ? state.replay.events : filteredEvents(); }

function renderReplay() {
  const events=replayItems();
  $('#replay-position').max=Math.max(0,events.length-1);
  $('#replay-position').value=Math.min(state.replay.cursor,Math.max(0,events.length-1));
  $('#replay-progress').textContent=`${events.length ? Math.min(state.replay.cursor+1,events.length) : 0} / ${events.length}`;
  $('#replay-play').textContent=state.replay.playing?'Ⅱ':'▶';
  $('#replay-play').disabled=!events.length;
  $('#replay-play').setAttribute('aria-label',state.replay.playing?'暂停回放':'开始回放');
  $('#replay-play').title=state.replay.playing?'暂停回放':'开始回放';
  $('#replay-label').textContent=state.replay.mode ? state.replay.playing?'正在回放':state.replay.finished?'回放结束':'回放已暂停' : '回听执行';
  $('#replay-basis').textContent=replayHasTimes(events)?'按源时间回放 · 保留等待':'按事件顺序试听 · 每条 0.4 秒';
  $('#return-live').hidden=!state.replay.mode;
}

function stopReplay(returnLive=false) {
  clearTimeout(state.replay.timer); state.replay.generation++; state.replay.playing=false; state.replay.currentId=null; audio.cancel();
  if(returnLive) {state.replay.mode=false;state.replay.cursor=0;state.replay.events=[];state.replay.finished=false;}
  renderReplay(); renderSessionHeading();
}

async function toggleReplay() {
  if(state.replay.playing) { stopReplay(); renderTimeline(); return; }
  if(!state.replay.mode) {state.replay.events=filteredEvents().slice();state.replay.mode=true;}
  if(!state.replay.events.length) return;
  const sessionKey=state.selectedKey;
  await enableAudio();
  if(sessionKey!==state.selectedKey)return;
  if(state.replay.finished)state.replay.cursor=0;
  state.replay.finished=false;
  if(state.replay.events.length>state.visibleLimit){state.visibleLimit=state.events.length;renderTimeline();}
  state.replay.playing=true;
  const generation=++state.replay.generation;
  const hasTimes=replayHasTimes(state.replay.events);
  const playNext=()=>{
    if(generation!==state.replay.generation || !state.replay.playing) return;
    const events=state.replay.events;
    const current=events[state.replay.cursor];
    if(!current) { stopReplay(); return; }
    state.replay.currentId=eventId(current);
    void soundEvent(current,'回放');
    for(const row of $('#timeline').querySelectorAll('.event-row')) {
      const active=row.dataset.eventId===eventId(current); row.classList.toggle('playing',active);
      if(active) row.scrollIntoView({block:'nearest',behavior:'auto'});
    }
    renderReplay(); renderSessionHeading();
    if(state.replay.cursor>=events.length-1) {
      state.replay.playing=false;state.replay.finished=true;renderReplay();return;
    }
    const delay=hasTimes?timestamp(events[state.replay.cursor+1])-timestamp(current):400;
    const speed=Number($('#replay-speed').value)||1;
    state.replay.timer=setTimeout(()=>{state.replay.cursor++;playNext();},Math.max(15,delay/speed));
  };
  playNext();
}

function filtersChanged() {
  state.pendingViewRestore=null;
  if(state.replay.mode) stopReplay(true);
  state.query=$('#event-search').value.trim(); state.category=$('#category-filter').value; state.skill=$('#skill-filter').value;state.skillEvidence=$('#skill-evidence-filter').value; state.failures=$('#failure-filter').checked; state.visibleLimit=500;
  updateSkillEvidenceOptions();
  renderTimeline();
}

function queueSettingsSave() {
  clearTimeout(saveTimer); const revision=++savedRevision;
  $('#settings-state').textContent='保存中…'; $('#settings-state').classList.remove('error');
  saveTimer=setTimeout(()=>{
    const snapshot=structuredClone(state.settings);
    saveChain=saveChain.catch(()=>{}).then(()=>api('/api/settings',{method:'PUT',json:snapshot})).then(()=>{
      if(revision===savedRevision) $('#settings-state').textContent='已保存';
    }).catch(error=>{ $('#settings-state').textContent='保存失败 · 请重试修改'; $('#settings-state').classList.add('error'); toast(`设置未保存：${error.message}`,true); });
  },200);
}

function soundOptions(select, selected) {
  select.replaceChildren();
  for(const sound of SOUND_PRESETS) addOption(select,sound.id,sound.label);
  for(const asset of state.sounds) addOption(select,asset.sound,asset.name);
  if(selected && ![...select.options].some(option=>option.value===selected)) addOption(select,selected,`不可用：${selected}`);
  select.value=selected || 'mute';
}

function renderSoundSettings() {
  const list=$('#rule-list'); list.replaceChildren();
  $('#rule-count').textContent=state.settings.rules.length;
  $('#rules-empty').hidden=state.settings.rules.length>0;
  state.settings.rules.forEach((rule,index)=>{
    const item=el('div',`rule-item${rule.enabled?'':' disabled'}`);
    const toggle=el('input'); toggle.type='checkbox';toggle.checked=rule.enabled;toggle.setAttribute('aria-label',`启用第 ${index+1} 条规则`);toggle.addEventListener('change',()=>{rule.enabled=toggle.checked;settingsChanged();});
    const chips=el('div','rule-match');
    for(const [key,value] of Object.entries(rule.match || {})) {
      const contains = key === 'callContains' || typeof value === 'object';
      chips.append(el('span','match-chip',`${MATCH_LABELS[key] || key}${contains ? ' 包含' : ' ='} ${contains && typeof value === 'object' ? value.contains : value}`));
    }
    if(!Object.keys(rule.match || {}).length) chips.append(el('span','match-chip','全部事件'));
    const controls=el('div','rule-controls');
    const up=makeButton('↑','icon-button',()=>moveRule(index,-1),'上移规则'); up.disabled=index===0;
    const down=makeButton('↓','icon-button',()=>moveRule(index,1),'下移规则'); down.disabled=index===state.settings.rules.length-1;
    controls.append(makeButton('▷','icon-button',()=>run(()=>previewSound(rule.sound,rule.volume)),'试听规则'),up,down,makeButton('编辑','icon-button',()=>openRule(rule),'编辑规则'),makeButton('×','icon-button danger',()=>{state.settings.rules.splice(index,1);settingsChanged();},'删除规则'));
    item.append(el('span','rule-order',String(index+1).padStart(2,'0')),toggle,chips,el('span','rule-sound',soundLabel(rule.sound)),controls); list.append(item);
  });
  const defaults=$('#category-sounds'); defaults.replaceChildren();
  for(const [category,label] of Object.entries(CATEGORY_LABELS)) {
    const row=el('div','category-sound');const select=el('select');select.setAttribute('aria-label',`${label}默认音色`);soundOptions(select,state.settings.categorySounds[category] || 'mute');
    select.addEventListener('change',()=>{state.settings.categorySounds[category]=select.value;settingsChanged(false);});
    row.append(el('span','',categoryLabel(category)),select,makeButton('▷','icon-button',()=>run(()=>previewSound(select.value)),'试听类别音色'));defaults.append(row);
  }
  const assets=$('#asset-list');assets.replaceChildren();
  for(const asset of state.sounds) {const chip=el('div','asset-chip');chip.append(el('span','',asset.name),makeButton('▷','icon-button',()=>run(()=>previewSound(asset.sound)),'试听本地音频'));assets.append(chip);}
  renderCatalog();
}

function settingsChanged(render=true) { queueSettingsSave(); if(render) renderSoundSettings();renderTimeline();if(state.selectedEvent){const event=state.events.find(item=>eventId(item)===state.selectedEvent);if(event)showDetail(event);} }
function moveRule(index,delta) { const target=index+delta;if(target<0 || target>=state.settings.rules.length)return;const [rule]=state.settings.rules.splice(index,1);state.settings.rules.splice(target,0,rule);settingsChanged(); }

function openRule(rule=null, match={}, sound='wood') {
  state.editingRuleId=rule?.id || null;
  const form=$('#rule-form');form.reset();$('#rule-error').textContent='';
  $('#rule-dialog-title').textContent=rule?'编辑声音规则':'添加声音规则';
  const category=form.elements.namedItem('category');category.replaceChildren();addOption(category,'','不限类别');for(const [id,label]of Object.entries(CATEGORY_LABELS))addOption(category,id,label);
  for(const key of Object.keys(MATCH_LABELS)) {
    const value = (rule?.match || match)[key];
    form.elements.namedItem(key).value = typeof value === 'object' ? value.contains : value || '';
    if(NAME_FIELDS.includes(key)) form.elements.namedItem(`${key}Mode`).value = typeof value === 'object' ? 'contains' : 'equals';
  }
  soundOptions(form.elements.namedItem('sound'),rule?.sound || sound);
  form.elements.namedItem('volume').value=rule?.volume ?? .5;
  form.elements.namedItem('enabled').checked=rule?.enabled ?? true;
  $('#rule-dialog').showModal();
}

function renderCatalog() {
  const query=$('#catalog-search').value.trim().toLowerCase();
  const list=$('#catalog-list');list.replaceChildren();
  const hookCoverage={'turn-handler-audit':'开放回合内可记录 handler 审计','detached-no-handler-audit':'可预配声音；当前缺少逐 handler 审计'};
  const entries=[...state.catalog.events.map(item=>({name:item.type,label:item.label,description:item.description,match:{type:item.type},kind:'事件'})),...state.catalog.hooks.map(item=>({name:item.point,label:'Hook',description:hookCoverage[item.coverage] || humanValue(item.coverage),match:{hookPoint:item.point},kind:'Hook'}))];
  for(const item of entries.filter(item=>`${item.name} ${item.label} ${item.description}`.toLowerCase().includes(query))) {
    const row=el('div','catalog-item');const copy=el('div');copy.append(el('code','',item.name),el('p','',`${item.kind} · ${item.description || item.label || '语义尚未分类'}`));
    row.append(copy,makeButton('配声','button small',()=>openRule(null,item.match)));list.append(row);
  }
  if(!list.childElementCount) list.append(el('p','fine-print','没有匹配的目录项。可以直接添加按原生名称匹配的规则。'));
}

function renderCatalogOptions() {
  const category=$('#category-filter');category.replaceChildren();addOption(category,'','全部类别');for(const [id,label]of Object.entries(CATEGORY_LABELS))addOption(category,id,categoryLabel(id));category.value=state.category;
  const eventTypes=$('#event-types');eventTypes.replaceChildren();for(const item of state.catalog.events)addOption(eventTypes,item.type,item.label || item.type);
  const hookPoints=$('#hook-points');hookPoints.replaceChildren();for(const item of state.catalog.hooks)addOption(hookPoints,item.point,item.point);
}

function humanValue(value) { if(value==null)return'—';if(typeof value==='boolean')return value?'支持':'不支持';if(typeof value==='object')return JSON.stringify(value);return String(value); }
function renderStatus() {
  const status=state.status;if(!status)return;
  const connected=Boolean(status.collector?.connected);
  $('#collector-state').textContent=connected?'已连接':'等待 dsh 接入';
  $('#collector-state').className=`mode-pill${connected?'':' demo'}`;
  const details=$('#connection-details');details.replaceChildren();
  const fields=[['服务版本',status.version],['接收地址',status.connection?.endpoint],['插件路径',status.connection?.pluginPath],['采集来源 ID',status.connection?.instanceId],['凭据文件',status.connection?.tokenFile],['记录目录',status.dataDir],['最近投递',status.collector?.lastSeen?timeText(status.collector.lastSeen,true):'还没有收到现场事件'],['已保留记录',`${status.counts?.sessions || 0} 个会话 / ${status.counts?.events || 0} 条事件`]];
  for(const [key,value]of fields)details.append(el('dt','',key),el('dd','',humanValue(value)));
  const patch=status.connection?.patch;
  const command=status.connection?.command;
  $('#connection-setup').hidden=!patch && !command;
  $('#connection-command-block').hidden=!command;
  $('#connection-patch').textContent=typeof patch==='string'?patch:patch?JSON.stringify(patch,null,2):'当前来源未提供启动配置。';
  $('#connection-command').textContent=command || '';
  const coverage=$('#coverage-list');coverage.replaceChildren();
  const coverageLabels={mode:'采集方式',nativeVersion:'dsh 版本',knownEvents:'已知原生事件',hookAudit:'Hook 审计',limitations:'当前边界'};
  const coverageValues={'dsh-post-commit':'事件提交后接收','open-turn-only':'开放回合内的 handler'};
  for(const [key,value]of Object.entries(status.coverage || {})){
    const row=el('div','coverage-item');row.append(el('span','',coverageLabels[key] || key));
    if(Array.isArray(value)){const list=el('ul','coverage-notes');for(const note of value)list.append(el('li','',humanValue(note)));row.append(list);}
    else row.append(el('span','',coverageValues[value] || humanValue(value)));
    coverage.append(row);
  }
  if(!coverage.childElementCount)coverage.append(el('p','fine-print','接入后显示来源报告的覆盖能力。'));
  updateConnection();
}

function updateConnection() {
  const dot=$('#connection-dot');dot.className=`connection-dot${state.streamConnected?' connected':' error'}`;
  $('#connection-label').textContent=!state.streamConnected?'记录连接中断 · 正在重连':state.status?.collector?.connected?'本地在线 · dsh 已接入':'本地在线 · 等待 dsh';
}

async function importFile(file) {
  if(!file)return;
  toast(`正在导入 ${file.name}…`);
  let result;
  if(file.name.toLowerCase().endsWith('.json')) {
    let json;try{json=JSON.parse(await file.text());}catch{throw new Error('JSON 文件无法解析，请检查导出格式。');}
    result=await api('/api/import',{method:'POST',json});
  } else result=await api('/api/import',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(file.name)},body:file});
  await refreshSessions();
  const key=result.sessionKeys?.[0];
  if(key) {if(key===state.selectedKey)await loadEvents();else await selectSession(key);}
  toast(`导入完成 · 新增 ${result.accepted || 0} 条，重复 ${result.duplicates || 0} 条${result.issues?.length?`，${result.issues.length} 项需检查`:''}`);
}

async function loadDemo(live=false) {
  if(live) await enableAudio();
  const result=await api('/api/demo',{method:'POST',json:{}});
  await refreshSessions();
  const key=result.sessionKeys?.[0] || state.sessions.find(session=>session.sourceKind==='demo')?.key;
  if(key) {if(key===state.selectedKey)await loadEvents();else await selectSession(key);}
  if(live) {state.pendingLiveDemo=true;try{await api('/api/demo/live',{method:'POST',json:{}});}catch(error){state.pendingLiveDemo=false;throw error;}toast('现场模拟已开始 · 正在打开新的演示会话'); }
  else toast('演示会话已载入 · 点击回听可试听执行');
}

function connectStream() {
  const stream=new EventSource('/api/stream');let opened=false;
  stream.addEventListener('open',()=>{
    const reconnect=opened;opened=true;state.streamConnected=true;updateConnection();
    run(async()=>{await refreshSessions({chooseFirst:true});await loadEvents();state.status=await api('/api/status');renderStatus();if(reconnect)toast('已重新连接，缺失记录已静默补齐。');});
  });
  stream.addEventListener('error',()=>{state.streamConnected=false;updateConnection();});
  stream.addEventListener('status',event=>{try{state.status=JSON.parse(event.data);renderStatus();}catch{toast('收到无法读取的状态消息。',true);}});
  stream.addEventListener('update',message=>{
    let data;try{data=JSON.parse(message.data);}catch{toast('收到无法读取的事件消息。',true);return;}
    if(state.pendingLiveDemo){
      const demo=(data.events || []).find(event=>event.sourceKind==='demo' && !event.historical);
      if(demo){state.pendingLiveDemo=false;run(async()=>{await refreshSessions();await selectSession(demo.sessionKey);toast('正在监听现场模拟 · 模拟数据不会启动 agent。');});}
    }
    const incoming=(data.events || []).filter(event=>event.sessionKey===state.selectedKey);
    const existing=new Set(state.events.map(eventId));
    const fresh=incoming.filter(event=>!existing.has(eventId(event)));
    if(incoming.length) {
      state.events=mergeEvents(state.events,incoming);updateSkillOptions();renderTimeline();renderSessionHeading();
      if(!state.replay.mode && !data.historical && !state.loading)for(const event of fresh){
        if(event.historical)continue;
        const time=timestamp(event);
        if(time && Date.now()-time>15000)continue;
        if(filteredEvents().some(item=>eventId(item)===eventId(event)))void soundEvent(event,'现场');
      }
    }
    clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>run(async()=>{await refreshSessions({chooseFirst:true});state.catalog=await api('/api/catalog');renderCatalogOptions();renderCatalog();}),180);
  });
}

function bindEvents() {
  for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>showTab(button.dataset.tab));
  for(const button of document.querySelectorAll('[data-open-tab]'))button.addEventListener('click',()=>showTab(button.dataset.openTab));
  $('#session-search').addEventListener('input',renderSessions);
  for(const id of ['event-search','category-filter','skill-filter','skill-evidence-filter','failure-filter'])$('#'+id).addEventListener(id==='event-search'?'input':'change',filtersChanged);
  $('#clear-filters').addEventListener('click',()=>{$('#event-search').value='';$('#category-filter').value='';$('#skill-filter').value='';$('#skill-evidence-filter').value='';$('#failure-filter').checked=false;filtersChanged();});
  $('#follow-button').addEventListener('click',()=>{state.follow=!state.follow;$('#follow-button').classList.toggle('active',state.follow);$('#follow-button').textContent=state.follow?'跟随最新 ↓':'已停止跟随';if(state.follow)$('#timeline').scrollTop=$('#timeline').scrollHeight;});
  $('#close-detail').addEventListener('click',closeDetail);
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeDetail();});
  $('#audio-toggle').addEventListener('click',()=>run(async()=>{if(state.settings.audio.enabled && state.audioReady){state.settings.audio.enabled=false;audio.cancel();renderAudio();queueSettingsSave();}else await enableAudio();}));
  $('#master-volume').addEventListener('input',()=>{state.settings.audio.volume=Number($('#master-volume').value);renderAudio();queueSettingsSave();});
  $('#replay-play').addEventListener('click',()=>run(toggleReplay));
  $('#replay-stop').addEventListener('click',()=>{stopReplay();state.replay.cursor=0;state.replay.finished=false;renderTimeline();});
  $('#return-live').addEventListener('click',()=>{stopReplay(true);renderTimeline();toast('已返回现场 · 历史事件不会补播。');});
  $('#replay-position').addEventListener('input',()=>{const cursor=Number($('#replay-position').value);stopReplay();if(!state.replay.mode){state.replay.events=filteredEvents().slice();state.replay.mode=true;}state.replay.cursor=cursor;state.replay.finished=false;renderReplay();renderSessionHeading();});
  $('#replay-speed').addEventListener('change',()=>{if(state.replay.playing){stopReplay();run(toggleReplay);}});
  for(const id of ['import-button','empty-import','connection-import'])$('#'+id).addEventListener('click',()=>$('#import-file').click());
  $('#import-file').addEventListener('change',()=>{const file=$('#import-file').files[0];$('#import-file').value='';run(()=>importFile(file));});
  $('#export-button').addEventListener('click',()=>{if(!state.selectedKey)return;const link=el('a');link.href=`/api/sessions/${encodeURIComponent(state.selectedKey)}/export`;link.download=`symphony-${currentSession()?.id || 'session'}.json`;link.click();});
  $('#empty-demo').addEventListener('click',()=>run(()=>loadDemo()));$('#demo-button').addEventListener('click',()=>run(()=>loadDemo()));$('#live-demo-button').addEventListener('click',()=>run(()=>loadDemo(true)));
  $('#refresh-status').addEventListener('click',()=>run(async()=>{state.status=await api('/api/status');renderStatus();toast('状态已刷新。');}));
  for(const [buttonId,targetId]of [['copy-connection-command','connection-command'],['copy-connection-patch','connection-patch']])$('#'+buttonId).addEventListener('click',()=>run(async()=>{
    const text=$('#'+targetId).textContent;
    if(!navigator.clipboard?.writeText)throw new Error('浏览器不支持自动复制，请选择并复制下方文字。');
    try{await navigator.clipboard.writeText(text);}catch{throw new Error('复制未获浏览器允许，请选择并复制下方文字。');}
    toast(buttonId==='copy-connection-command'?'接入命令已复制。':'dsh 插件配置已复制。');
  }));
  $('#add-rule').addEventListener('click',()=>openRule());
  $('#add-watch-rule').addEventListener('click',()=>openRule(null,{callContains:'gstack'},'dissonance'));
  for(const id of ['close-rule','cancel-rule'])$('#'+id).addEventListener('click',()=>$('#rule-dialog').close());
  $('#preview-rule').addEventListener('click',()=>run(()=>previewSound($('#rule-form').elements.namedItem('sound').value,Number($('#rule-form').elements.namedItem('volume').value))));
  $('#rule-form').addEventListener('submit',event=>{
    event.preventDefault();const form=event.currentTarget;const match={};
    for(const key of Object.keys(MATCH_LABELS)) {
      const value=form.elements.namedItem(key).value.trim();
      if(value) match[key]=NAME_FIELDS.includes(key) && form.elements.namedItem(`${key}Mode`).value === 'contains' ? {contains:value} : value;
    }
    if(!Object.keys(match).length){$('#rule-error').textContent='至少选择一个事件、类别或调查对象，以免意外覆盖全部声音。';return;}
    const rule={id:state.editingRuleId || crypto.randomUUID(),enabled:form.elements.namedItem('enabled').checked,match,sound:form.elements.namedItem('sound').value,volume:Number(form.elements.namedItem('volume').value)};
    const index=state.settings.rules.findIndex(item=>item.id===rule.id);if(index>=0)state.settings.rules[index]=rule;else state.settings.rules.unshift(rule);
    $('#rule-dialog').close();settingsChanged();toast(index>=0?'规则已更新。':'规则已添加到列表顶部。');
  });
  $('#catalog-search').addEventListener('input',renderCatalog);
  $('#sound-upload').addEventListener('change',()=>run(async()=>{
    const file=$('#sound-upload').files[0];$('#sound-upload').value='';if(!file)return;if(file.size>5*1024*1024)throw new Error('音频超过 5 MB，请选择更短的声音。');
    const asset=await api('/api/sounds',{method:'POST',headers:{'Content-Type':file.type || 'application/octet-stream','X-Filename':encodeURIComponent(file.name)},body:file});
    state.sounds.push(asset);audio.setAssets(state.sounds);renderSoundSettings();toast(`已保存本地音频：${asset.name}`);
  }));
}

async function init() {
  bindEvents();
  const [settings,catalog,status,sounds]=await Promise.all([api('/api/settings'),api('/api/catalog'),api('/api/status'),api('/api/sounds')]);
  state.settings={audio:{enabled:false,volume:.35,...settings.audio},rules:settings.rules || [],categorySounds:settings.categorySounds || {}};
  state.catalog=catalog;state.status=status;state.sounds=sounds.sounds || [];audio.setAssets(state.sounds);
  renderAudio();renderCatalogOptions();renderSoundSettings();renderStatus();
  await refreshSessions({chooseFirst:true});connectStream();
}

run(init);
