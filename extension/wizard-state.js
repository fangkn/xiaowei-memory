export function createWizardState() {
  return { step: 1, mode: 'page', connected: false, savedCount: 0, phase: 'idle', canConfirm: false, month: '' };
}

export function isWizardBusy(state) {
  return ['preparing', 'collecting', 'stopping', 'exporting', 'verifying'].includes(state.phase);
}

// 向导只描述进度；数据库落盘和下载核验由业务层完成后再发送成功事件。
export function transitionWizard(state, event) {
  const busy = isWizardBusy(state);
  switch (event.type) {
    case 'CONNECTION': return { ...state, connected: Boolean(event.connected) };
    case 'SAVED': return { ...state, savedCount: Math.max(0, Number(event.count) || 0) };
    case 'NEXT': return !busy && state.step === 1 && state.connected ? { ...state, step: 2, phase: 'idle' } : state;
    case 'MODE': return !busy && state.step === 2 && ['page', 'history'].includes(event.mode) ? { ...state, mode: event.mode } : state;
    case 'PREPARE': return state.connected && state.phase === 'idle' && [2, 3].includes(state.step) ? { ...state, phase: 'preparing' } : state;
    case 'STARTED': return state.phase === 'preparing' ? { ...state, step: 3, phase: 'collecting' } : state;
    case 'STOPPING': return state.phase === 'collecting' ? { ...state, phase: 'stopping' } : state;
    case 'SETTLED': return ['preparing', 'collecting', 'stopping'].includes(state.phase) ? { ...state, phase: 'idle' } : state;
    case 'OPEN_EXPORT': return !busy && state.savedCount > 0 ? { ...state, step: 4, phase: 'idle', canConfirm: false } : state;
    case 'EXPORTING': return state.step === 4 && ['idle', 'downloaded'].includes(state.phase) ? { ...state, phase: 'exporting', canConfirm: false } : state;
    case 'DOWNLOAD': return state.phase === 'exporting' ? { ...state, phase: 'downloaded', canConfirm: Boolean(event.canConfirm) } : state;
    case 'EXPORT_FAILED': return state.phase === 'exporting' ? { ...state, phase: 'idle', canConfirm: false } : state;
    case 'VERIFY': return state.phase === 'downloaded' && state.canConfirm ? { ...state, phase: 'verifying' } : state;
    case 'VERIFY_FAILED': return state.phase === 'verifying' ? { ...state, phase: 'downloaded' } : state;
    case 'CONFIRMED': return state.phase === 'verifying' ? { ...state, phase: 'done', month: event.month, canConfirm: false } : state;
    case 'INVALIDATE_DOWNLOAD': return !busy && state.phase === 'downloaded' ? { ...state, phase: 'idle', canConfirm: false } : state;
    case 'BACK': return !busy ? { ...state, step: state.step === 4 ? (state.connected ? 3 : 1) : 1, phase: 'idle', canConfirm: false } : state;
    case 'RESELECT': return !busy ? { ...state, step: state.connected ? 2 : 1, phase: 'idle', canConfirm: false } : state;
    case 'RESET': return !busy ? { ...state, step: 1, phase: 'idle', canConfirm: false, month: '' } : state;
    case 'NEXT_MONTH': return state.phase === 'done' ? { ...state, phase: 'idle', canConfirm: false } : state;
    default: return state;
  }
}
