import {createWizardState,transitionWizard,isWizardBusy} from './wizard-state.js';

export const embedded = window.parent !== window;
export async function panelMessage(message) {
  if (!embedded) return { ok: true };
  return chrome.runtime.sendMessage(message);
}

export function setupPanelUI() {
  const $ = id => document.getElementById(id);
  const main = $('backupPanel');
  let state = createWizardState();
  let lastHeight = 0, scheduled = false, externalBusy = false;
  function hideClosePrompt() {
    $('closePrompt').hidden = true;
    $('panelClose').setAttribute('aria-expanded','false');
    measure();
  }
  function showClosePrompt() {
    $('closePrompt').hidden = false;
    $('panelClose').setAttribute('aria-expanded','true');
    $('closeMinimize').focus();
    measure();
  }
  async function windowAction(type) {
    $('panelActionStatus').hidden = true;
    try {
      const result = await panelMessage({type});
      if (result?.busy) { showClosePrompt(); return; }
      if (!result?.ok) throw new Error(result?.error || '连接已失效，请刷新微博后再次点击扩展。');
    } catch (error) {
      $('panelActionStatus').textContent = error.message;
      $('panelActionStatus').hidden = false;
      measure();
    }
  }
  function measure() {
    if (scheduled || !embedded) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const height = Math.ceil(main.getBoundingClientRect().height) + 2;
      if (height === lastHeight) return;
      lastHeight = height;
      panelMessage({type:'WOB_PANEL_RESIZE',height}).catch(() => {});
    });
  }
  function render() {
    const busy = isWizardBusy(state) || externalBusy;
    if (!busy && !$('closePrompt').hidden) hideClosePrompt();
    for (const section of document.querySelectorAll('[data-wizard-step]')) section.hidden = Number(section.dataset.wizardStep) !== state.step;
    for (const dot of document.querySelectorAll('[data-step-dot]')) {
      dot.classList.toggle('current', Number(dot.dataset.stepDot) === state.step);
      dot.classList.toggle('complete', Number(dot.dataset.stepDot) < state.step);
    }
    $('stepNumber').textContent = `0${state.step} / 04`;
    $('stepTitle').textContent = state.step === 1 ? (state.connected ? '确认你的微博账号' : '先打开个人主页') :
      state.step === 2 ? '想备份哪些微博？' : state.step === 3 ?
      (state.phase === 'collecting' ? '正在保存你的微博' : state.phase === 'stopping' ? '正在保存进度…' : state.phase === 'preparing' ? '正在连接微博…' : state.savedCount ? '可以导出了' : '暂未找到微博') :
      state.phase === 'done' ? '这一份，保存好了' : '按月保存原创';
    $('connectionHint').textContent = state.connected ? '确认是要备份的账号，然后继续。' : '在微博里点击自己的头像，再点下方「重新识别」。';
    $('wizardNext').disabled = busy || !state.connected;
    $('wizardNext').hidden = !state.connected;
    $('wizardLocalExport').hidden = state.savedCount === 0;
    $('wizardLocalExport').disabled = busy;
    $('wizardLocalExport').textContent = `导出已有 ${state.savedCount} 条原创`;
    $('wizardLocalExport').classList.toggle('primary', !state.connected);
    $('wizardLocalExport').classList.toggle('text-button', state.connected);
    $('connect').disabled = busy;
    $('connect').hidden = state.connected;
    $('pageOptions').hidden = state.mode !== 'page';
    $('historyOptions').hidden = state.mode !== 'history';
    for (const radio of document.querySelectorAll('input[name="backupMode"]')) {
      radio.disabled = busy;
      radio.checked = radio.value === state.mode;
    }
    $('wizardStart').disabled = busy || !state.connected;
    $('wizardStart').textContent = state.phase === 'preparing' ? '正在准备…' : '开始备份';
    $('wizardBack').disabled = busy;
    $('collectedCount').textContent = state.savedCount;
    $('pageProgress').hidden = state.mode !== 'page';
    $('historyProgress').hidden = state.mode !== 'history';
    const collecting = state.phase === 'collecting';
    $('pageProgress').dataset.active = String(collecting);
    $('pageProgress').setAttribute('aria-valuetext', collecting ? '正在采集，微博总数未知' : state.phase === 'stopping' ? '正在保存进度，微博总数未知' : state.phase === 'preparing' ? '正在准备采集，微博总数未知' : '采集已暂停，微博总数未知');
    $('historyProgressInfo').hidden = state.mode !== 'history';
    $('pause').hidden = !['collecting','stopping'].includes(state.phase);
    $('pause').disabled = state.phase !== 'collecting';
    $('pause').textContent = state.phase === 'stopping' ? '正在暂停…' : '暂停';
    $('wizardResume').hidden = busy;
    $('wizardResume').disabled = !state.connected;
    $('wizardToExport').disabled = busy || state.savedCount === 0;
    $('wizardReselect').hidden = busy;
    $('wizardExportBack').disabled = busy;
    $('exportReady').hidden = state.phase === 'done';
    $('exportDone').hidden = state.phase !== 'done';
    $('status').hidden = state.step >= 3;
    $('doneMonth').textContent = state.month === 'unknown' ? '未知日期笔记' : state.month;
    $('export').disabled = busy || !$('batch').value;
    const pdf=$('format').value!=='markdown',multiple=$('batch').value==='all';
    const fileLabel=pdf?(multiple?'月度 PDF':'PDF'):'ZIP';
    $('export').textContent=state.phase==='exporting'?'正在导出…':state.phase==='downloaded'?(state.canConfirm?`重新下载 ${fileLabel}`:'重试未完成月份'):$('export').dataset.resume==='true'?'继续导出':`下载 ${fileLabel}`;
    $('doneHint').textContent=pdf?'文件已下载。多个月份统一保存在一个 ZIP 中，解压后每月一份 PDF。':'文件已下载。解压 ZIP，把「微博备份」放入 Obsidian 仓库，保留 assets 文件夹。';
    $('export').classList.toggle('primary',state.phase!=='downloaded');
    $('export').classList.toggle('secondary',state.phase==='downloaded');
    $('confirmExport').hidden = !['downloaded','verifying'].includes(state.phase) || !state.canConfirm;
    $('confirmExport').disabled = state.phase !== 'downloaded' || !state.canConfirm;
    $('confirmExport').textContent = state.phase === 'verifying' ? '正在确认…' : '已核对下载，完成';
    measure();
  }
  function dispatch(event) {
    const oldStep = state.step;
    state = transitionWizard(state,event);
    render();
    if (oldStep !== state.step) {
      $('helpPanel').hidden = true;
      $('panelHelp').setAttribute('aria-expanded','false');
      window.scrollTo({top:0,behavior:'instant'});
      $('stepTitle').focus({preventScroll:true});
    }
    return state;
  }
  for (const radio of document.querySelectorAll('input[name="backupMode"]')) radio.addEventListener('change', () => dispatch({type:'MODE',mode:radio.value}));
  $('panelHelp').addEventListener('click', () => {
    $('helpPanel').hidden = !$('helpPanel').hidden;
    $('panelHelp').setAttribute('aria-expanded',String(!$('helpPanel').hidden));
    measure();
  });
  $('panelMinimize').hidden = !embedded;
  $('panelClose').hidden = !embedded;
  $('panelClose').addEventListener('click', () => {
    if (isWizardBusy(state) || externalBusy) { showClosePrompt(); return; }
    hideClosePrompt();
    return windowAction('WOB_PANEL_CLOSE');
  });
  const minimize = () => { hideClosePrompt(); return windowAction('WOB_PANEL_MINIMIZE'); };
  $('panelMinimize').addEventListener('click', minimize);
  $('closeMinimize').addEventListener('click', minimize);
  $('closeCancel').addEventListener('click', () => { hideClosePrompt(); $('panelClose').focus(); });
  new ResizeObserver(measure).observe(main);
  render();
  return {
    get state() { return state; },
    dispatch,
    render,
    setAccount(uid,name='',localOnly=false) {
      $('accountName').textContent = name || (uid ? '微博账号' : '等待识别');
      $('accountUid').textContent = uid ? `${localOnly?'本机已有记录 · ':''}UID ${uid}` : '尚未连接微博账号';
      dispatch({type:'CONNECTION',connected:!!uid&&!localOnly});
    },
    setSavedCount(count) { dispatch({type:'SAVED',count}); },
    setActivity(running,exporting) {
      externalBusy = running || exporting;
      const activity = running || ['preparing','stopping'].includes(state.phase) ? 'collecting' : exporting || state.phase==='verifying' ? 'exporting' : 'idle';
      $('panelActivity').textContent = state.phase==='stopping'?'正在保存进度…':state.phase==='preparing'?'正在准备…':{idle:'就绪',collecting:'采集中，可最小化',exporting:'处理中，请稍候'}[activity];
      $('panelActivity').dataset.state=activity;
      panelMessage({type:'WOB_PANEL_ACTIVITY',state:activity}).catch(() => {});
      render();
    }
  };
}
