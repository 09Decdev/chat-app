const io = require('socket.io-client');
const LOGIN_URL = 'http://localhost:3000/auth/login';
const GATEWAY = 'http://localhost:3000';
const ROOM = 'r2';
const DEV = { installationId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', deviceFingerprint: 'e4d5c6b7a8091827364554637281900a1b2c3d4e5f607182930a0b0c0d0e0f10', deviceName: 'd', platform: 'android' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function login(email){const r=await fetch(LOGIN_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'S1234567*s',deviceInfo:DEV})});return (await r.json()).accessToken;}
async function getMsgs(token){const r=await fetch(`http://localhost:3000/content-service/chat/rooms/${ROOM}/messages?limit=10`,{headers:{Authorization:'Bearer '+token}});const j=await r.json();const d=j.data??j;const arr=(d&&d.data)?d.data:(Array.isArray(d)?d:[]);return arr;}
(async()=>{
  const t=await login('shin1@gmail.com');
  const s=io(GATEWAY,{transports:['websocket'],query:{token:t},reconnection:false,timeout:10000});
  let echoT=null; const marker='LAT_'+Date.now();
  s.on('chat:message',m=>{if(m?.message?.content===marker){echoT=Date.now();console.log('ECHO received at +',(echoT-sendT)+'ms');}});
  s.on('chat:joined',()=>console.log('joined'));
  await sleep(1500); s.emit('chat:join',{roomId:ROOM}); await sleep(1500);
  const sendT=Date.now(); s.emit('chat:send',{roomId:ROOM,content:marker});
  console.log('SENT',marker,'at',new Date(sendT).toISOString());
  for(let i=0;i<30;i++){
    await sleep(1000);
    const msgs=await getMsgs(t);
    const found=msgs.some(m=>m.content===marker);
    console.log(`+${(i+1)}s persist=${found} echo=${echoT?'yes':'no'}`);
    if(found&&echoT)break;
  }
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
