// ── State ─────────────────────────────────────────────────────────────────────
let peer, currentCall;
let localStream = null;
let isMuted = false, isSpeaker = false;
let dialValue = '';
let callSeconds = 0, timerInterval = null;
let incomingCall = null;
let ringtoneCtx = null, ringtoneInterval = null;
let callTimeout = null;
let callAnswered = false;
let callEnding = false;
let sigConn = null;
let heartbeatSendInterval = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupNumpad();
  initPeer();
  checkPermissionState();
});

// ── Microphone ────────────────────────────────────────────────────────────────
async function ensureStream() {
  // If we already have a live stream, reuse it
  if (localStream && localStream.getAudioTracks().some(t => t.readyState === 'live')) {
    return localStream;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showPermOverlay('مرورگر شما از میکروفون پشتیبانی نمی‌کند.');
    return null;
  }
  // getUserMedia must be called synchronously inside user gesture
  // Return the promise directly without awaiting anything before it
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    hidePermOverlay();
    localStream = s;
    return localStream;
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      showPermOverlay('دسترسی رد شد. در تنظیمات مرورگر اجازه میکروفون را فعال کنید.');
    } else if (e.name === 'NotFoundError') {
      toast('میکروفون پیدا نشد');
    } else if (e.name === 'NotReadableError') {
      toast('میکروفون در حال استفاده است');
    } else {
      toast('خطا: ' + e.name);
    }
    return null;
  }
}

// Call this once on first user interaction to warm up mic permission
async function primeMic() {
  if (localStream) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream = s;
    hidePermOverlay();
  } catch(e) {
    if (e.name === 'NotAllowedError') showPermOverlay('دسترسی رد شد.');
  }
}

async function checkPermissionState() {
  if (!navigator.permissions) return;
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    if (p.state === 'denied') showPermOverlay('دسترسی رد شده. در تنظیمات مرورگر اجازه دهید.');
    p.onchange = () => {
      if (p.state === 'denied') showPermOverlay('دسترسی رد شده.');
      else hidePermOverlay();
    };
  } catch(e) {}
}

// ── PeerJS ────────────────────────────────────────────────────────────────────
function initPeer() {
  const myId = String(Math.floor(100000 + Math.random() * 900000));
  document.getElementById('myId').textContent = myId;

  peer = new Peer(myId, {
    host: '0.peerjs.com', port: 443, secure: true, path: '/',
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });

  peer.on('open', () => {
    setStatusWave(true);
    document.getElementById('statusTxt').textContent = 'آماده برای تماس';
    toast('متصل شد ✓');
  });

  // Rejection/heartbeat handled in unified connection block below

  peer.on('call', (call) => {
    incomingCall = call;
    document.getElementById('incomingId').textContent = call.peer;
    showScreen('screenIncoming');
    playRingtone();

    call.on('close', () => {
      if (incomingCall) {
        stopRingtone();
        incomingCall = null;
        showScreen('screenMain');
        toast('تماس‌گیرنده قطع کرد');
      }
    });

    call.on('error', () => {
      if (incomingCall) {
        stopRingtone();
        incomingCall = null;
        showScreen('screenMain');
        toast('اتصال قطع شد');
      }
    });
  });

  // Heartbeat from caller — if stops, caller hung up
  peer.on('connection', (conn) => {
    let heartbeatTimer = null;

    conn.on('open', () => {
      resetHeartbeat();
    });

    conn.on('data', (data) => {
      if (data === 'rejected') {
        clearCallTimeout();
        endCall(false);
        toast('مقصد تماس را رد کرد');
      } else if (data === 'heartbeat') {
        resetHeartbeat();
      } else if (data === 'cancel') {
        if (incomingCall) {
          clearTimeout(heartbeatTimer);
          stopRingtone();
          incomingCall = null;
          showScreen('screenMain');
          toast('تماس‌گیرنده قطع کرد');
        }
      }
    });

    conn.on('close', () => {
      clearTimeout(heartbeatTimer);
      if (incomingCall) {
        stopRingtone();
        incomingCall = null;
        showScreen('screenMain');
        toast('تماس‌گیرنده قطع کرد');
      }
    });

    function resetHeartbeat() {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        if (incomingCall) {
          stopRingtone();
          incomingCall = null;
          showScreen('screenMain');
          toast('تماس‌گیرنده قطع کرد');
        }
      }, 5000); // 5s no heartbeat = caller gone
    }
  });

  // peer-unavailable fires instantly if ID not found
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') {
      clearCallTimeout();
      endCall(false);
      toast('این شناسه آنلاین نیست');
    } else if (err.type === 'network' || err.type === 'server-error') {
      endCall('error');
    } else {
      toast('خطا: ' + err.type);
      setStatusWave(false);
    }
  });

  peer.on('disconnected', () => {
    setStatusWave(false);
    document.getElementById('statusTxt').textContent = 'قطع اتصال';
  });
}

// ── Numpad ────────────────────────────────────────────────────────────────────
function setupNumpad() {
  document.querySelectorAll('.num[data-val]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (dialValue.length < 6) { dialValue += btn.dataset.val; updateDial(); }
    });
  });
  document.getElementById('btnDel').addEventListener('click', () => {
    dialValue = dialValue.slice(0, -1); updateDial();
  });
  document.getElementById('btnCall').addEventListener('click', startCall);
  document.getElementById('btnReject').addEventListener('click', rejectCall);
  document.getElementById('btnAccept').addEventListener('click', acceptCall);
  document.getElementById('btnHangup').addEventListener('click', hangup);
  document.getElementById('btnMute').addEventListener('click', toggleMute);
  document.getElementById('btnSpeaker').addEventListener('click', toggleSpeaker);
}

function updateDial() {
  const box = document.getElementById('dialDisplay');
  if (!dialValue) {
    box.textContent = '_ _ _ _ _ _';
    box.style.color = '';
  } else {
    box.textContent = dialValue;
    box.style.color = '#e2e8f0';
  }
}

// ── Call flow ─────────────────────────────────────────────────────────────────
async function startCall() {
  if (dialValue.length < 4) { toast('شناسه را وارد کنید'); return; }
  if (dialValue === document.getElementById('myId').textContent) {
    toast('نمی‌توانید به خودتان زنگ بزنید'); return;
  }

  // Get mic FIRST — must be the first await after user click
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  }).then(s => { localStream = s; hidePermOverlay(); return s; })
    .catch(e => {
      if (e.name === 'NotAllowedError') showPermOverlay('دسترسی رد شد.');
      else toast('خطا: ' + e.name);
      return null;
    });

  if (!stream) return;

  callAnswered = false;
  const targetId = dialValue;

  // Open data connection for signaling (heartbeat + cancel)
  sigConn = peer.connect(targetId);
  sigConn.on('open', () => {
    heartbeatSendInterval = setInterval(() => {
      try { sigConn.send('heartbeat'); } catch(e) {}
    }, 2000);
  });

  currentCall = peer.call(targetId, stream);
  // if peer-unavailable, error fires before we even show screen
  // so we show screen immediately and let error handler clean up if needed

  document.getElementById('callWithId').textContent = targetId;
  document.getElementById('callTimer').textContent = 'در انتظار پاسخ...';
  showScreen('screenCall');

  setupCallHandlers(currentCall);

  // 30s timeout if no answer
  callTimeout = setTimeout(() => {
    if (!callAnswered) {
      endCall(false);
      toast('پاسخی دریافت نشد');
    }
  }, 30000);
}

async function acceptCall() {
  stopRingtone();

  // Get mic FIRST — must be the first await after user click
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  }).then(s => { localStream = s; hidePermOverlay(); return s; })
    .catch(e => {
      if (e.name === 'NotAllowedError') showPermOverlay('دسترسی رد شد.');
      else toast('خطا: ' + e.name);
      return null;
    });

  if (!stream) return;

  incomingCall.answer(stream);
  document.getElementById('callWithId').textContent = incomingCall.peer;
  currentCall = incomingCall;
  incomingCall = null;
  callAnswered = true;
  setupCallHandlers(currentCall);
  showScreen('screenCall');
  startTimer();
}

function rejectCall() {
  stopRingtone();
  if (incomingCall) {
    try {
      const conn = peer.connect(incomingCall.peer);
      conn.on('open', () => {
        conn.send('rejected');
        setTimeout(() => { try { conn.close(); } catch(e){} }, 800);
      });
    } catch(e) {}
    incomingCall.close();
    incomingCall = null;
  }
  showScreen('screenMain');
}

function setupCallHandlers(call) {
  call.on('stream', (s) => {
    document.getElementById('remoteAudio').srcObject = s;
    callAnswered = true;
    clearCallTimeout();
    startTimer();
    attachIceHandler(call);
  });

  call.on('close', () => {
    if (callEnding) return;
    endCall(callAnswered ? 'remote' : false);
  });

  call.on('error', () => {
    endCall('error');
  });
}

// Attach ICE handler after peerConnection is ready
function attachIceHandler(call) {
  const pc = call.peerConnection;
  if (!pc) return;
  let iceDropTimer = null;
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'disconnected' || s === 'failed') {
      if (callEnding) return;
      // 3s grace period for mobile network fluctuations
      iceDropTimer = setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          endCall('error');
        }
      }, 3000);
    } else if (s === 'connected' || s === 'completed') {
      clearTimeout(iceDropTimer);
    }
  };
}

function hangup() {
  // Send cancel to callee if not yet answered
  if (!callAnswered && typeof sigConn !== 'undefined' && sigConn) {
    try { sigConn.send('cancel'); } catch(e) {}
  }
  if (typeof heartbeatSendInterval !== 'undefined') {
    clearInterval(heartbeatSendInterval);
  }
  if (currentCall) { try { currentCall.close(); } catch(e){} }
  endCall('self');
}

// reason: 'self' | 'remote' | 'error' | false
function endCall(reason) {
  if (callEnding) return;
  callEnding = true;

  clearCallTimeout();
  stopTimer();
  stopRingtone();
  callAnswered = false;

  // Stop heartbeat
  if (typeof heartbeatSendInterval !== 'undefined' && heartbeatSendInterval) {
    clearInterval(heartbeatSendInterval);
    heartbeatSendInterval = null;
  }
  if (typeof sigConn !== 'undefined' && sigConn) {
    try { sigConn.close(); } catch(e) {}
    sigConn = null;
  }

  if (currentCall) { try { currentCall.close(); } catch(e){} currentCall = null; }

  document.getElementById('remoteAudio').srcObject = null;
  isMuted = false; isSpeaker = false;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = true);
  document.getElementById('btnMute').classList.remove('active');
  document.getElementById('btnSpeaker').classList.remove('active');

  showScreen('screenMain');

  if (reason === 'self')   toast('تماس را قطع کردید');
  if (reason === 'remote') toast('طرف مقابل قطع کرد');
  if (reason === 'error')  toast('اتصال قطع شد');

  setTimeout(() => { callEnding = false; }, 500);
}

function clearCallTimeout() {
  if (callTimeout) { clearTimeout(callTimeout); callTimeout = null; }
}

// ── In-call controls ──────────────────────────────────────────────────────────
function toggleMute() {
  isMuted = !isMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  document.getElementById('btnMute').classList.toggle('active', isMuted);
  toast(isMuted ? 'میکروفون خاموش شد' : 'میکروفون روشن شد');
}

function toggleSpeaker() {
  isSpeaker = !isSpeaker;
  document.getElementById('btnSpeaker').classList.toggle('active', isSpeaker);
  toast(isSpeaker ? 'بلندگو روشن شد' : 'بلندگو خاموش شد');
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  stopTimer();
  callSeconds = 0;
  timerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    document.getElementById('callTimer').textContent = m + ':' + s;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  callSeconds = 0;
}

// ── Ringtone ──────────────────────────────────────────────────────────────────
function playRingtone() {
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    function beep() {
      const osc = ringtoneCtx.createOscillator();
      const gain = ringtoneCtx.createGain();
      osc.connect(gain); gain.connect(ringtoneCtx.destination);
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.2, ringtoneCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ringtoneCtx.currentTime + 0.5);
      osc.start(); osc.stop(ringtoneCtx.currentTime + 0.5);
    }
    beep();
    ringtoneInterval = setInterval(beep, 1500);
  } catch(e) {}
}

function stopRingtone() {
  clearInterval(ringtoneInterval); ringtoneInterval = null;
  if (ringtoneCtx) { try { ringtoneCtx.close(); } catch(e){} ringtoneCtx = null; }
}

// ── UI ────────────────────────────────────────────────────────────────────────
function showScreen(id) {
  ['screenMain','screenIncoming','screenCall'].forEach(s => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
}

function setStatusWave(on) {
  document.getElementById('statusWave').classList.toggle('on', on);
}

function showPermOverlay(msg) {
  document.getElementById('overlayPerm').classList.remove('hidden');
  const t = document.getElementById('permTxt');
  if (t && msg) t.textContent = msg;
}

function hidePermOverlay() {
  document.getElementById('overlayPerm').classList.add('hidden');
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
