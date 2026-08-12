const io = require('socket.io-client');
const LOGIN_URL = 'http://localhost:3000/auth/login';
const GATEWAY = 'http://localhost:3000';
const ROOM = 'r2';
const DEV = { installationId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', deviceFingerprint: 'e4d5c6b7a8091827364554637281900a1b2c3d4e5f607182930a0b0c0d0e0f10', deviceName: 'd', platform: 'android' };

async function login(email) {
  const r = await fetch(LOGIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'S1234567*s', deviceInfo: DEV }) });
  const j = await r.json();
  if (!j.accessToken) throw new Error('no token: ' + JSON.stringify(j));
  return j.accessToken;
}
function connect(token, tag) {
  const s = io(GATEWAY, { transports: ['websocket'], query: { token }, reconnection: false, timeout: 10000 });
  s.on('connect', () => console.log(tag, 'connected', s.id));
  s.on('disconnect', r => console.log(tag, 'disconnect', r));
  s.on('connect_error', e => console.log(tag, 'connect_error', e.message));
  return s;
}
(async () => {
  const t1 = await login('shin1@gmail.com');
  const t2 = await login('shin2@gmail.com');
  const s1 = connect(t1, 'S1');
  const s2 = connect(t2, 'S2');
  const recv1 = [], recv2 = [];
  s1.on('chat:message', m => { recv1.push(m); console.log('S1 recv id=' + m?.message?.id + ' content=' + m?.message?.content); });
  s2.on('chat:message', m => { recv2.push(m); console.log('S2 recv id=' + m?.message?.id + ' content=' + m?.message?.content); });
  s1.on('chat:joined', d => console.log('S1 joined', d?.roomId));
  s2.on('chat:joined', d => console.log('S2 joined', d?.roomId));
  s1.on('chat:error', e => console.log('S1 ERROR', e));
  s2.on('chat:error', e => console.log('S2 ERROR', e));
  await new Promise(r => setTimeout(r, 1500));
  s1.emit('chat:join', { roomId: ROOM });
  s2.emit('chat:join', { roomId: ROOM });
  await new Promise(r => setTimeout(r, 2000));
  const myMarker = 'MYMSG_' + Date.now();
  // shin2 spam 15 msgs nhanh
  for (let i = 0; i < 15; i++) {
    s2.emit('chat:send', { roomId: ROOM, content: 'spam' + i });
    await new Promise(r => setTimeout(r, 8));
  }
  // shin1 gửi 1 tin giữa lúc spam
  s1.emit('chat:send', { roomId: ROOM, content: myMarker });
  await new Promise(r => setTimeout(r, 5000));
  console.log('=== RESULT ===');
  console.log('S1 received total:', recv1.length);
  console.log('S1 got OWN echo (' + myMarker + '):', recv1.some(m => m?.message?.content === myMarker));
  console.log('S1 got shin2 spam echoes:', recv1.filter(m => String(m?.message?.content || '').startsWith('spam')).length, '/15');
  console.log('S2 received total:', recv2.length);
  console.log('S2 got OWN spam echoes:', recv2.filter(m => String(m?.message?.content || '').startsWith('spam')).length, '/15');
  console.log('S2 got shin1 echo (' + myMarker + '):', recv2.some(m => m?.message?.content === myMarker));
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
