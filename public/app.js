import { CONFIG } from './config.js';
import { tutorPrompt, lecturePrompt } from './prompts.js';
import { hasScoringTranscript, scoreSessionRecord } from './score-session.js';
import { AudioBridge } from './audio.js';
import { saveSession, allSessions, downloadJson } from './storage.js';

const el = id => document.getElementById(id);
const keys = { voice: 'learn100-voice-key', ark: 'learn100-ark-key', speed: 'learn100-speed' };
const stageNames = { opening: ['开场一问', '说说你原本怎么想，猜一下也行。'], talk: ['听小练讲', '先听一会儿，讲完轮到你。'], retell: ['现在轮到你', '用自己的话讲一讲。说完点“说完了”。'], followup: ['再聊一个问题', '小练只追问一次。'] };
let concepts = [], selected = null, session = null, socket = null, audio = null;
const catalog = { query:'', zone:'all', scope:'all', openZones:new Set() };
let stage = '', stageSince = 0, listening = false, callTimer = null, modelText = '', responseHandled = new Set();
let ttsQueue = [], ttsMode = '', awaitingFollowupAnswer = false, answerSubmitted = false, ending = false;
let pendingUserPhases = [];
let closeAckResolver = null;
let sessionsCache = [];

function notice(message) { el('notice').textContent = message; el('notice').hidden = !message; }
function scoreProblem(message, retryable) {
  el('feedback-loading').hidden = true; el('score-error').hidden = false;
  el('score-error').querySelector('p').textContent = message;
  el('retry-score').hidden = !retryable;
}
function view(name) { for (const id of ['home','detail','call','feedback']) el(id).hidden = id !== name; window.scrollTo(0, 0); }
function save() { if (session) return saveSession(session).catch(() => notice('本地保存失败，请先导出当前记录。')); }
function currentSeconds() { return session ? (Date.now() - Date.parse(session.started_at)) / 1000 : 0; }
function addTranscript(role, phase, text) {
  if (!text?.trim()) return;
  session.transcript.push({ role, phase, text: text.trim(), t: Number(currentSeconds().toFixed(1)) });
  if (role === 'user' && phase === 'retell') session.retell_char_count += text.trim().length;
  save();
  el('live-text').textContent = `${role === 'tutor' ? CONFIG.tutorName : '你'}：${text.trim()}`;
}
function setStage(next) {
  const now = Date.now();
  if (stage && stageSince) session.phase_durations[stage] = (session.phase_durations[stage] || 0) + (now - stageSince) / 1000;
  stage = next; stageSince = now; session.phase = next; save();
  for (const name of Object.keys(stageNames)) {
    const node = el(`stage-${name}`); node.className = name === next ? 'active' : Object.keys(stageNames).indexOf(name) < Object.keys(stageNames).indexOf(next) ? 'done' : '';
  }
  const [title, description] = stageNames[next] || ['通话结束', '正在保存记录'];
  el('call-kicker').textContent = next === 'retell' ? 'YOUR TURN' : 'ON THE CALL';
  el('call-title').textContent = title; el('call-instruction').textContent = description;
  el('retell-hint').hidden = next !== 'retell';
  el('speak-button').disabled = !['opening','retell','followup'].includes(next) || (next === 'followup' && !awaitingFollowupAnswer);
  el('orb').className = `orb ${next === 'talk' || (next === 'followup' && !awaitingFollowupAnswer) ? 'talking' : 'listening'}`;
}
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }

function renderList() {
  const spokenIds = new Set(sessionsCache.filter(item => item.status_after === 'spoken').map(item => item.concept_id));
  const query = catalog.query.trim().toLocaleLowerCase('zh-CN');
  const matches = concepts.filter(concept => {
    if (catalog.zone !== 'all' && concept.zone !== catalog.zone) return false;
    if (catalog.scope === 'learnable' && spokenIds.has(concept.id)) return false;
    if (!query) return true;
    return [concept.name, concept.definition, concept.zone, concept.analogy,
      ...(Array.isArray(concept.ok_terms) ? concept.ok_terms : []), ...(Array.isArray(concept.eng_ok) ? concept.eng_ok : [])]
      .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
  });
  const zones = [...new Set(concepts.map(item => item.zone))];
  el('concept-count').textContent = `${matches.length} / ${concepts.length} 个概念`;
  const renderedGroups = zones.flatMap(zone => {
    const zoneConcepts = concepts.filter(item => item.zone === zone);
    const visible = matches.filter(item => item.zone === zone);
    if (!visible.length) return [];
    const details = document.createElement('details'); details.className = 'zone-group';
    details.open = Boolean(query) || catalog.zone !== 'all' || catalog.openZones.has(zone);
    details.addEventListener('toggle', () => details.open ? catalog.openZones.add(zone) : catalog.openZones.delete(zone));
    const summary = document.createElement('summary');
    const title = document.createElement('span'); title.className = 'zone-title'; title.textContent = zone;
    const count = document.createElement('span'); count.className = 'zone-count';
    count.textContent = visible.length === zoneConcepts.length ? `${zoneConcepts.length} 个` : `${visible.length} / ${zoneConcepts.length}`;
    summary.append(title, count); details.append(summary);
    const rows = document.createElement('div'); rows.className = 'concept-list';
    for (const concept of visible) {
      const index = concepts.indexOf(concept);
      const button = document.createElement('button'); button.className = 'concept-row'; button.type = 'button';
      const number = document.createElement('span'); number.className = 'number'; number.textContent = String(index + 1).padStart(2, '0');
      const middle = document.createElement('span'); const name = document.createElement('strong'); name.textContent = concept.name;
      const meta = document.createElement('small');
      const prior = sessionsCache.filter(item => item.concept_id === concept.id && item.ended_at).sort((a,b) => b.started_at.localeCompare(a.started_at))[0];
      meta.textContent = prior?.status_after === 'spoken' ? '已讲出来' : concept.prerequisites.length ? `前置 ${concept.prerequisites.length} 个 · 可开始` : '可直接开始';
      middle.append(name, meta); const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '↗';
      button.append(number, middle, arrow); button.addEventListener('click', () => choose(concept)); rows.append(button);
    }
    details.append(rows); return [details];
  });
  el('concept-groups').replaceChildren(...renderedGroups);
  el('empty-catalog').hidden = matches.length > 0;
  el('catalog-hint').textContent = catalog.scope === 'learnable'
    ? '显示还没有讲出来的概念。前置只作提醒；切到“全部”可复习已学内容。'
    : '按主题浏览。前置概念只作提醒，全部 100 个概念都可以开始。';
}
function choose(concept) {
  selected = concept; const index = concepts.indexOf(concept);
  el('detail-index').textContent = String(index + 1).padStart(2, '0');
  el('detail-name').textContent = concept.name; el('detail-definition').textContent = concept.definition;
  el('detail-prereqs').textContent = concept.prerequisites.length ? `建议先了解：${concept.prerequisites.join('、')}` : '从这里开始也可以。';
  el('detail-flow').textContent = concept.opening_question ? '开场问 → 讲解 → 复述 → 追问' : '讲解 → 复述 → 追问';
  const last = sessionsCache.filter(s => s.concept_id === concept.id && s.ended_at).sort((a,b) => b.ended_at.localeCompare(a.ended_at))[0];
  el('resume-score').hidden = !last;
  el('resume-score').textContent = last?.judge ? '查看上次反馈' : '给上次通话重新评分';
  el('resume-score').onclick = () => { session = structuredClone(last); showFeedback(); if (!last.judge) scoreSession(); };
  view('detail'); notice('');
}

async function startCall() {
  const voiceKey = el('voice-key').value.trim(), arkKey = el('ark-key').value.trim();
  if (!voiceKey || !arkKey) { notice('请先填写豆包语音和火山方舟的 API Key。'); el('detail').querySelector('details').open = true; return; }
  localStorage.setItem(keys.voice, voiceKey); localStorage.setItem(keys.ark, arkKey); localStorage.setItem(keys.speed, el('speed').value);
  notice(''); ending = false; listening = false; answerSubmitted = false; awaitingFollowupAnswer = false; ttsQueue = []; ttsMode = ''; modelText = ''; responseHandled = new Set(); pendingUserPhases = [];
  session = { id: crypto.randomUUID(), concept_id: selected.id, started_at: new Date().toISOString(), ended_at: null, mode:'call',
    phase: '', hint_viewed:false, transcript:[], judge:null, judge_raw:null, status_after:'none',
    phase_durations:{ opening:0,talk:0,retell:0,followup:0 }, retell_speech_seconds:0, retell_char_count:0,
    token_usage:{ voice:[], judge:null, lecture:null }, interrupted:false, exit_phase:null, voice_session_id:null, error:null };
  await save();
  el('call-concept').textContent = selected.name; el('call-clock').textContent = '00:00'; el('live-text').textContent = '';
  el('hint-text').textContent = selected.retell_scaffold; el('retell-hint').open = false;
  el('speak-button').textContent = '开始说话'; el('speak-button').classList.remove('recording');
  el('stage-opening').hidden = !selected.opening_question;
  setStage(selected.opening_question ? 'opening' : 'talk');
  el('speak-button').disabled = true; el('interrupt-button').hidden = true;
  view('call');
  try { audio = new AudioBridge(send); await audio.start(); }
  catch (error) { notice(error.name === 'NotAllowedError' ? '麦克风被拒绝。请在浏览器设置中允许麦克风。' : '无法打开麦克风，请检查设备权限。'); await finishCall(false); return; }
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket.onopen = () => send({ kind:'auth', key:voiceKey });
  socket.onmessage = event => { let data; try { data = JSON.parse(event.data); } catch { return; } handleEvent(data); };
  socket.onerror = () => { if (!ending) notice('网络连接中断，转写已保存。可以稍后重新评分。'); };
  socket.onclose = () => { if (!ending) { notice('语音连接已断开，转写已保存。'); finishCall(false); } };
  callTimer = setInterval(() => {
    const seconds = Math.floor(currentSeconds()); el('call-clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
    if (seconds >= CONFIG.callLimitSeconds) { notice('通话已到十分钟，正在保存并结束。'); finishCall(true); }
  }, 1000);
}

function playTts(text, mode) {
  ttsMode = mode;
  ttsQueue = text.match(/[^。！？!?]{1,180}[。！？!?]?/g)?.filter(Boolean) || [text];
  nextTts();
}
function nextTts() { if (ttsQueue.length) send({ type:'speech_text_buffer.commit', text:ttsQueue.shift(), event_id:crypto.randomUUID() }); }
async function beginDialogue() {
  send({ type:'input_audio_mute.commit' });
  if (selected.opening_question) {
    const question = selected.opening_question.ask;
    addTranscript('tutor','opening',question); playTts(question,'opening');
  } else {
    try {
      const result = await textRequest(lecturePrompt(selected, nextConceptName()), { concept:selected.name });
      session.token_usage.lecture = result.usage; save();
      const script = JSON.parse(result.content).script;
      if (typeof script !== 'string' || script.length < 100) throw new Error('讲解内容格式不正确');
      addTranscript('tutor','talk',script); playTts(script,'lecture');
    } catch (error) { notice(`讲解生成失败：${error.message}。本次记录已保存。`); await finishCall(false); }
  }
}

function nextConceptName() { return concepts[concepts.indexOf(selected) + 1]?.name || ''; }

function handleEvent(event) {
  if (event.kind === 'ready') {
    send({ type:'session.create', event_id:crypto.randomUUID(), session:{ model:CONFIG.voiceModel, instructions:tutorPrompt(selected, nextConceptName()),
      audio:{ input:{ format:{ type:'pcm', rate:16000 } }, output:{ format:{ type:'pcm_s16le', rate:24000 }, speed:Number(el('speed').value), loudness:0, voice:CONFIG.voice } } }, extension:{ asr:{}, tts:{}, dialog:{} } });
    return;
  }
  if (event.kind === 'error' || event.type === 'error') {
    const text = event.message || event.error?.message || '语音服务出现错误。';
    const details = [
      Number.isInteger(event.status) ? `HTTP ${event.status}` : '',
      event.providerCode ? `火山错误码 ${event.providerCode}` : '',
      event.requestId ? `请求 ID ${event.requestId}` : ''
    ].filter(Boolean);
    session.error = `语音连接失败：${text}${details.length ? `（${details.join('；')}）` : ''}`;
    notice(session.error);
    save();
    finishCall(false); return;
  }
  if (event.type === 'session.closed') { closeAckResolver?.(); closeAckResolver = null; return; }
  if (event.type === 'session.created') { session.voice_session_id = event.session?.id || null; save(); beginDialogue(); return; }
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    addTranscript('user', pendingUserPhases.shift() || stage, event.transcript || ''); return;
  }
  if (event.type === 'conversation.item.input_audio_transcription.failed') { pendingUserPhases.shift(); notice('这句话没有识别清楚，可以再说一次。'); return; }
  if (event.type === 'response.output_text.delta') { modelText += event.delta || ''; el('live-text').textContent = `${CONFIG.tutorName}：${modelText}`; return; }
  if (event.type === 'response.output_text.done') {
    const text = event.text || modelText;
    if (!ttsMode) addTranscript('tutor', stage, text);
    modelText = ''; return;
  }
  if (event.type === 'response.output_audio.delta') { audio?.play(event.delta || event.audio); return; }
  if (event.type === 'response.output_audio.done' && ttsMode) { onTtsDone(); return; }
  if (event.type === 'response.done') {
    const usage = event.usage || event.response?.usage;
    if (usage) { session.token_usage.voice.push(usage); save(); }
    if (!ttsMode) onModelDone(event.response_id || event.event_id || String(Date.now()));
  }
}

async function onTtsDone() {
  await audio?.drained();
  if (ending) return;
  if (ttsQueue.length) { nextTts(); return; }
  const mode = ttsMode; ttsMode = '';
  if (mode === 'opening') { el('speak-button').disabled = false; el('orb').className = 'orb listening'; el('call-title').textContent = '先说说你的想法'; }
  if (mode === 'lecture') { setStage('retell'); }
}

async function onModelDone(id) {
  if (responseHandled.has(id)) return; responseHandled.add(id);
  await audio?.drained(); if (ending) return;
  if (stage === 'talk') { el('interrupt-button').hidden = true; setStage('retell'); }
  else if (stage === 'followup' && !awaitingFollowupAnswer) { awaitingFollowupAnswer = true; setStage('followup'); el('speak-button').disabled = false; }
  else if (stage === 'followup' && answerSubmitted) await finishCall(true);
}

function toggleSpeech() {
  if (!audio || ending) return;
  if (!listening) {
    listening = true; el('speak-button').textContent = '说完了'; el('speak-button').classList.add('recording'); el('orb').className = 'orb listening'; audio.begin();
  } else {
    listening = false; const seconds = audio.finish();
    pendingUserPhases.push(stage);
    if (stage === 'retell') session.retell_speech_seconds += seconds;
    if (stage === 'opening') { setStage('talk'); el('interrupt-button').hidden = false; }
    else if (stage === 'retell') { awaitingFollowupAnswer = false; setStage('followup'); }
    else if (stage === 'followup') { answerSubmitted = true; el('speak-button').disabled = true; el('call-title').textContent = '小练正在收尾'; }
    el('speak-button').textContent = '开始说话'; el('speak-button').classList.remove('recording'); save();
  }
}

function interrupt() {
  if (stage !== 'talk') return;
  send({ type:'response.cancel', event_id:crypto.randomUUID() }); audio?.interrupt();
  if (modelText) { addTranscript('tutor','talk',modelText); modelText = ''; }
  session.interrupted = true; el('interrupt-button').hidden = true; setStage('retell');
}

async function finishCall(shouldScore) {
  if (ending || !session) return; ending = true;
  clearInterval(callTimer);
  if (listening) { pendingUserPhases.push(stage); audio?.finish(); listening = false; }
  if (pendingUserPhases.length && socket?.readyState === WebSocket.OPEN) {
    const until = Date.now() + 2000;
    while (pendingUserPhases.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (stage && stageSince) session.phase_durations[stage] += (Date.now() - stageSince) / 1000;
  session.exit_phase = shouldScore ? null : stage;
  session.ended_at = new Date().toISOString(); session.phase = 'end'; await save();
  if (socket?.readyState === WebSocket.OPEN) {
    await Promise.race([
      new Promise(resolve => { closeAckResolver = resolve; send({ type:'session.close', event_id:crypto.randomUUID() }); }),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
  }
  closeAckResolver = null;
  try { socket?.close(1000); } catch {}
  await audio?.stop(); socket = null; audio = null;
  sessionsCache = await allSessions(); showFeedback();
  if (shouldScore) await scoreSession();
  else scoreProblem(hasScoringTranscript(session) ? '转写已保存，评分尚未完成。你可以稍后重评。' : '本次没有可评分的复述内容。请检查连接后重试。', hasScoringTranscript(session));
}

async function textRequest(prompt, input) {
  const response = await fetch('/api/score', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ key:el('ark-key').value.trim(), model:CONFIG.judgeModel, prompt, input }) });
  const result = await response.json();
  if (!response.ok) {
    const details = [
      result.status ? `方舟 HTTP ${result.status}` : null,
      result.providerCode ? `错误码 ${result.providerCode}` : null,
      result.requestId ? `请求 ID ${result.requestId}` : null
    ].filter(Boolean).join(' · ');
    throw new Error(`${result.error || '评分失败'}${details ? `（${details}）` : ''}`);
  }
  return result;
}
async function scoreSession() {
  if (!session) return;
  const targetSession = session, targetConcept = selected, targetId = session.id;
  const isTargetFeedbackVisible = () => session?.id === targetId && selected?.id === targetConcept.id && !el('feedback').hidden;
  el('feedback-loading').hidden = false; el('score-error').hidden = true; el('feedback-content').hidden = true;
  try {
    const outcome = await scoreSessionRecord({ record:targetSession, concept:targetConcept, request:textRequest,
      persist:saveSession, isCurrent:id => session?.id === id && selected?.id === targetConcept.id && !el('feedback').hidden });
    sessionsCache = await allSessions();
    if (session?.id !== targetId) return;
    session = outcome.record;
    if (!isTargetFeedbackVisible()) return;
    if (outcome.error) {
      scoreProblem('转写已保存，但评分暂时失败。你可以稍后重评。', true);
      notice(`评分失败：${outcome.error.message}。转写已保存在浏览器里，可稍后重评。`);
      return;
    }
    renderFeedback(); renderList();
  } catch (error) {
    if (session?.id !== targetId) return;
    session = { ...targetSession, error:`本地保存失败：${error.message}` };
    if (!isTargetFeedbackVisible()) return;
    notice('本地保存失败，请先导出当前记录。');
    scoreProblem('本地保存失败。请导出本次记录后，再尝试保存。', false);
  }
}

function showFeedback() { el('feedback-name').textContent = selected.name; view('feedback'); if (session.judge) renderFeedback(); }
function renderFeedback() {
  const judge = session.judge; if (!judge) return;
  el('feedback-loading').hidden = true; el('feedback-content').hidden = false; el('score-error').hidden = true;
  el('coverage').textContent = `${judge.distinct_points_covered}/${judge.points.length}`;
  el('total-score').textContent = `${judge.total}/${judge.points.length * 2}`;
  el('point-list').replaceChildren(...judge.points.map((point, index) => {
    const article = document.createElement('article'); article.className = 'point';
    const head = document.createElement('div'); head.className = 'point-head';
    const h3 = document.createElement('h3'); h3.textContent = selected.key_points[index].point;
    const score = document.createElement('b'); score.textContent = `${point.score}/2`;
    const note = document.createElement('p'); note.textContent = point.note || (point.score ? '讲到了这一点。' : '这点还没有说到。');
    head.append(h3, score); article.append(head, note); return article;
  }));
  const copy = el('feedback-copy'); copy.replaceChildren();
  for (const value of [judge.feedback_for_user.did_well, judge.feedback_for_user.missing, judge.feedback_for_user.correct_if_needed]) {
    if (value) { const p = document.createElement('p'); p.textContent = value; copy.append(p); }
  }
  el('status-line').textContent = session.status_after === 'spoken' ? `这次讲出来了${session.hint_viewed ? ' · 看过提示' : ''}` : '再讲一遍，会更清楚。';
}

async function init() {
  el('voice-key').value = localStorage.getItem(keys.voice) || '';
  el('ark-key').value = localStorage.getItem(keys.ark) || '';
  el('speed').value = localStorage.getItem(keys.speed) || '0';
  try {
    concepts = await (await fetch('/api/concepts')).json(); sessionsCache = await allSessions();
    const zones = [...new Set(concepts.map(item => item.zone))];
    el('zone-filter').replaceChildren(new Option('全部主题', 'all'), ...zones.map(zone => new Option(zone, zone)));
    catalog.openZones.add(zones[0]);
    el('concept-search').addEventListener('input', event => { catalog.query = event.target.value; renderList(); });
    el('zone-filter').addEventListener('change', event => { catalog.zone = event.target.value; renderList(); });
    for (const button of document.querySelectorAll('[data-scope]')) button.addEventListener('click', () => {
      catalog.scope = button.dataset.scope;
      for (const option of document.querySelectorAll('[data-scope]')) option.setAttribute('aria-pressed', String(option === button));
      renderList();
    });
    renderList();
  }
  catch { notice('概念资料或本地记录暂时无法读取，请刷新页面。'); }
  el('start-call').onclick = startCall; el('speak-button').onclick = toggleSpeech; el('interrupt-button').onclick = interrupt;
  el('end-button').onclick = () => finishCall(true); el('retry-score').onclick = scoreSession;
  el('retell-hint').addEventListener('toggle', () => { if (session && el('retell-hint').open && stage === 'retell') { session.hint_viewed = true; save(); } });
  for (const back of document.querySelectorAll('[data-back]')) back.onclick = () => { renderList(); view('home'); notice(''); };
  el('another-concept').onclick = () => { renderList(); view('home'); notice(''); };
  el('export-session').onclick = () => session && downloadJson(session, `learn100-${session.id}.json`);
  el('export-all').onclick = async () => downloadJson(await allSessions(), `learn100-records-${new Date().toISOString().slice(0,10)}.json`);
  window.addEventListener('pagehide', () => { if (session && !session.ended_at) { session.exit_phase = stage; session.ended_at = new Date().toISOString(); session.phase_durations[stage] += (Date.now() - stageSince) / 1000; save(); } });
}
init();
