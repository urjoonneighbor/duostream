// Окно оверлея: показывает состояние, которое присылает главное окно (js/app.js → publishOverlay).
const $ = (s) => document.querySelector(s);

window.duo.overlay.onState((s) => {
  $('#card').hidden = !s.active;
  if (!s.active) return;
  $('#rowMe').classList.toggle('speaking', Boolean(s.meSpeaking));
  const me = $('#meState');
  me.textContent = s.mic;
  me.classList.toggle('off', Boolean(s.micOff));
  $('#rowPeer').hidden = !s.peerName;
  $('#peerName').textContent = s.peerName ?? '';
  $('#rowPeer').classList.toggle('speaking', Boolean(s.peerSpeaking));
  const peer = $('#peerState');
  peer.textContent = s.peerState ?? '';
  peer.classList.toggle('off', Boolean(s.peerState));
  $('#stream').textContent = s.stream ?? '';
  const message = $('#message');
  message.hidden = !s.message;
  message.textContent = s.message ?? '';
});
